// dsh-pixelfly — running an operation against the workspace.
//
// `runOperation` knows how to change a picture; this knows what that means for the
// history. It resolves the source version, stores the results, appends the version
// to the tree and writes the conversation lines. Both the HTTP route and the tool
// go through here so they cannot drift apart.

import { readConfig, sizesFor } from './config.js'
import { KeyPool } from './upstream.js'
import { runOperation } from './operations.js'
import { readAsset, saveAsset, addVersion, appendMessage, getWorkspace, getVersion, updateWorkspace } from './store.js'
import { probe } from './raster.js'

/**
 * Resolve the picture an operation should start from.
 *
 * `versionId` wins; otherwise the workspace's current version; otherwise the newest
 * successful version that actually has an image.
 */
function resolveSource(workspace, versionId) {
  if (typeof versionId === 'string' && versionId.length > 0) {
    const version = getVersion(versionId)
    const assetId = version.images?.[0]
    if (!assetId) return { version, source: null }
    return { version, source: { buffer: readAsset(assetId), mediaType: 'image/png' }, assetId }
  }
  const current = workspace.versions.find((row) => row.id === workspace.currentVersionId)
  if (current && current.images?.length > 0) {
    return { version: current, source: { buffer: readAsset(current.images[0]), mediaType: 'image/png' }, assetId: current.images[0] }
  }
  for (let index = workspace.versions.length - 1; index >= 0; index -= 1) {
    const version = workspace.versions[index]
    if (version.images?.length > 0) {
      return { version, source: { buffer: readAsset(version.images[0]), mediaType: 'image/png' }, assetId: version.images[0] }
    }
  }
  return { version: null, source: null }
}

/** Decode an uploaded picture from a data URL or bare base64. */
export function decodeUpload(value, config) {
  if (typeof value !== 'string' || value.length === 0) return null
  const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(value)
  const mediaType = match ? match[1] : 'image/png'
  const base64 = match ? match[2] : value
  let buffer
  try {
    buffer = Buffer.from(base64, 'base64')
  } catch {
    return null
  }
  if (buffer.length === 0) return null
  const limit = Math.max(1024, Math.min(64 * 1024 * 1024, Number(config.limits?.maxUploadBytes ?? 12582912)))
  if (buffer.length > limit) {
    throw new Error(`That picture is ${(buffer.length / 1024 / 1024).toFixed(1)}MB; the limit is ${(limit / 1024 / 1024).toFixed(0)}MB`)
  }
  return { buffer, mediaType }
}

/**
 * Run one operation and record it.
 *
 * `input` is the raw operation input; `options` carries `{ baseVersionId, config,
 * signal, onAttempt, onItem }`. There is exactly one workspace, so there is no
 * container to choose: every run appends to the same version tree.
 */
export async function execute(operation, input, options = {}) {
  const config = options.config ?? readConfig()
  const workspace = getWorkspace()

  const resolved = resolveSource(workspace, options.baseVersionId ?? input.baseVersionId)
  const uploaded = decodeUpload(input.image, config)

  // An explicit upload is a fresh starting point, not a branch of the current one.
  const source = uploaded ?? input.source ?? resolved.source ?? null
  const parentId = uploaded ? '' : (resolved.version?.id ?? '')

  const pool = new KeyPool(
    (config.apiKeys ?? []).filter((entry) => entry.enabled !== false && typeof entry.key === 'string' && entry.key.length > 0),
    { rotate: config.retry?.rotateKeys !== false, cooldownMs: config.retry?.cooldownMs ?? 60000 },
  )

  const context = {
    config,
    model: input.model || workspace?.models?.image || config.models?.default,
    visionModel: input.visionModel || workspace?.models?.vision || config.models?.visionDefault,
    stylePrompt: typeof input.stylePrompt === 'string' ? input.stylePrompt : workspace?.stylePrompt ?? '',
    source,
    signal: options.signal,
    onAttempt: options.onAttempt,
    onItem: options.onItem,
    pool,
  }

  const reference = decodeUpload(input.referenceImage, config)
  const result = await runOperation(operation, {
    ...input,
    source: operation === 'fusion' || operation === 'edit' || operation === 'colorize' ? source : input.source ?? source,
    reference: reference ?? (input.referenceImage ? undefined : input.reference),
  }, context)

  // Persist: assets first, then the version that points at them.
  const stored = []
  for (const image of result.images ?? []) {
    const info = await probe(image.buffer)
    const asset = saveAsset(image.buffer, { mediaType: 'image/png', width: info.width, height: info.height })
    stored.push(asset)
  }

  if (stored.length === 0 && operation !== 'distill') {
    throw new Error('The operation produced no picture')
  }

  const { version } = addVersion({
    parentId,
    op: operation,
    label: result.label,
    prompt: result.prompt,
    model: context.model,
    visionModel: result.meta?.visionModel ?? '',
    params: { size: input.size ?? '', n: input.n ?? 1, mode: input.mode ?? '', preset: input.preset ?? '' },
    images: stored.map((asset) => asset.id),
    meta: result.meta ?? {},
    notes: typeof input.notes === 'string' ? input.notes : '',
  })

  if (operation === 'distill') {
    const current = getWorkspace()
    updateWorkspace({ stylePrompt: current.stylePrompt || result.prompt })
  }

  appendMessage({
    role: 'assistant',
    kind: operation,
    text: result.label ?? operation,
    versionId: version.id,
    images: stored.map((asset) => asset.id),
    ok: true,
  })

  // The caller gets the whole workspace back, so a client can replace its state in
  // one step instead of merging a partial payload into an older copy.
  const fresh = getWorkspace()

  return {
    ok: true,
    op: operation,
    label: result.label,
    prompt: result.prompt,
    meta: result.meta,
    images: stored.map((asset) => ({ id: asset.id, width: asset.width, height: asset.height, bytes: asset.bytes })),
    version: { id: version.id, parentId: version.parentId, createdAt: version.createdAt, op: version.op, label: version.label },
    workspace: publicWorkspace(fresh),
  }
}

/** Strip nothing today, but keep one place that decides what a client may see. */
export function publicWorkspace(workspace) {
  return {
    id: workspace.id,
    stylePrompt: workspace.stylePrompt ?? '',
    models: workspace.models ?? { image: '', vision: '' },
    cover: workspace.cover ?? '',
    currentVersionId: workspace.currentVersionId ?? '',
    versions: workspace.versions ?? [],
    conversation: workspace.conversation ?? [],
  }
}

/** The sizes the current provider will accept. */
export function availableSizes(config = readConfig()) {
  return sizesFor(config)
}
