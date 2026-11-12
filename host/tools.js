// dsh-pixelfly — the model-facing tools.
//
// Deliberately small: make a picture, transform one, read the history, inspect the
// configuration, check the upstream. The definitions are plain objects (no import
// from the Harness packages) so this plugin loads from any directory without a
// build step.

import { activeKeys, maskKey, pluginRoot, publicConfig, readConfig, sizesFor, writeConfig } from './config.js'
import { listModels } from './upstream.js'
import { execute } from './session.js'
import {
  ASSET_KIND_LIST,
  COLOUR_MODE_LIST,
  ELEMENT_PRESET_LIST,
  FUSION_MODE_LIST,
  operationCatalog,
} from './operations.js'
import {
  deleteVersion,
  getWorkspace,
  patchVersion,
  readAsset,
  resetWorkspace,
  updateWorkspace,
} from './store.js'

const EDIT_OPS = ['edit', 'localEdit', 'fusion', 'outpaint', 'removeWatermark', 'removeBackground', 'removeElement', 'extractAsset', 'editText', 'enhance', 'colorize', 'batchVariables', 'batchList']

function renderText(text) {
  return [{ type: 'text', text }]
}

function opLine(result) {
  const parts = [result.label ?? result.op]
  if (result.meta?.attempts) parts.push(`${result.meta.attempts} attempt${result.meta.attempts === 1 ? '' : 's'}`)
  if (result.meta?.elapsedMs) parts.push(`${(result.meta.elapsedMs / 1000).toFixed(1)}s`)
  return parts.join(' · ')
}

/** Admit result assets into the attachment store so the chat can show them inline. */
async function admit(ctx, images) {
  let attachments
  try { attachments = ctx.get('attachments') } catch { attachments = undefined }
  if (!attachments || typeof attachments.saveImages !== 'function') return []
  const inputs = []
  for (const [index, image] of (images ?? []).entries()) {
    let bytes
    try { bytes = readAsset(image.id) } catch { continue }
    inputs.push({ data: new Uint8Array(bytes), mediaType: 'image/png', name: `pixelfly-${index + 1}.png` })
  }
  if (inputs.length === 0) return []
  try {
    return Array.from(await attachments.saveImages(inputs))
  } catch {
    return []
  }
}

function describeResult(result) {
  const lines = [opLine(result)]
  if (result.prompt) lines.push(`prompt: ${result.prompt.slice(0, 400)}`)
  if (result.version) lines.push(`version ${result.version.id}${result.version.parentId ? ` (from ${result.version.parentId})` : ''}`)
  for (const image of result.images ?? []) {
    lines.push(`- ${image.width}×${image.height}, ${(image.bytes / 1024).toFixed(0)} KiB, asset ${image.id}`)
  }
  if (result.meta?.trace?.length > 1) {
    lines.push('attempts:')
    for (const step of result.meta.trace) {
      const detail = step.status > 0 ? `HTTP ${step.status}` : step.code
      lines.push(`  ${step.attempt}. ${step.keyId} → ${detail} (${step.ms} ms)`)
    }
  }
  return lines.join('\n')
}

const IMAGE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      width: { type: 'integer' },
      height: { type: 'integer' },
      bytes: { type: 'integer' },
    },
  },
}

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    op: { type: 'string' },
    label: { type: 'string' },
    prompt: { type: 'string' },
    images: IMAGE_SCHEMA,
    attachments: { type: 'array', items: { type: 'object' } },
    version: { type: 'object' },
    meta: { type: 'object' },
  },
  required: ['ok', 'op'],
}

function renderResult(_args, value) {
  const blocks = renderText(describeResult(value))
  for (const attachment of value.attachments ?? []) {
    if (attachment && typeof attachment === 'object' && typeof attachment.attachmentId === 'string') {
      blocks.push({ type: 'image', attachment })
    }
  }
  return blocks
}

export function createTools(ctx) {
  const generate = {
    name: 'pixelfly_generate',
    description: 'Create a picture from a text prompt with the configured Pixelfly upstream and save it as a new version in the history. Returns the version id and the picture itself. Multiple API keys are rotated automatically with exponential backoff on rate limits and transient failures.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to draw. Be specific about subject, composition, lighting and style.' },
        model: { type: 'string', description: 'Image model id. Defaults to the configured default.' },
        size: { type: 'string', description: 'Output size such as 1024x1024. Defaults to the configured size.' },
        n: { type: 'integer', description: 'How many pictures to make (1-4). Defaults to 1.' },
        stylePrompt: { type: 'string', description: 'A style instruction appended to the prompt.' },
        watermark: { type: 'boolean', description: 'Ask the upstream to burn in a watermark.' },
      },
      required: ['prompt'],
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const result = await execute('text2image', args ?? {}, {
        config: readConfig(),
        signal: exec?.signal,
      })
      return { ...result, attachments: await admit(ctx, result.images) }
    },
    isConcurrencySafe: () => true,
    timeoutMs: 300000,
  }

  const edit = {
    name: 'pixelfly_edit',
    description: 'Transform an existing picture and save the result as a new version: prompt-based editing, regional repaint, reference fusion, outpainting, watermark removal, background removal, element removal, asset extraction, in-image text editing, enhancement, colourisation, and batch runs over a prompt list or [variable] matrix.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: EDIT_OPS, description: 'Which transformation to run.' },
        versionId: { type: 'string', description: 'The version to start from. Defaults to the current version.' },
        prompt: { type: 'string', description: 'The instruction or prompt. Meaning depends on op.' },
        rect: { type: 'object', description: 'A selection as percentages: {x, y, width, height} each 0-100.' },
        rects: { type: 'array', items: { type: 'object' }, description: 'Several selections, same percentage shape.' },
        keep: { type: 'array', items: { type: 'object' }, description: 'For removeElement: selections to leave alone.' },
        preset: { type: 'string', description: `For removeElement: ${ELEMENT_PRESET_LIST.map((row) => row.id).join(', ')}.` },
        kind: { type: 'string', description: `For extractAsset: ${ASSET_KIND_LIST.map((row) => row.id).join(', ')}.` },
        mode: { type: 'string', description: `For fusion: ${FUSION_MODE_LIST.map((row) => row.id).join(', ')}. For colorize: ${COLOUR_MODE_LIST.map((row) => row.id).join(', ')}.` },
        strength: { type: 'string', enum: ['light', 'standard', 'strong'], description: 'For enhance.' },
        instructions: { type: 'array', items: { type: 'string' }, description: 'For localEdit batch: 2-50 instructions applied to the same selection.' },
        prompts: { type: 'array', items: { type: 'string' }, description: 'For batchList: one prompt per line, one picture each.' },
        values: { type: 'object', description: 'For batchVariables: variable name to a list of values.' },
        regions: { type: 'array', items: { type: 'object' }, description: 'For editText: [{rect, text, next, drop}] text regions to replace or clear.' },
        palette: { type: 'string', description: 'For colorize: a colour direction such as "warm sepia".' },
        referenceImage: { type: 'string', description: 'A base64 data URL used as a reference picture.' },
        image: { type: 'string', description: 'A base64 data URL to use as the source instead of the current version.' },
        size: { type: 'string', description: 'Output size. Defaults to the source aspect ratio at a supported size.' },
        n: { type: 'integer', description: 'Pictures per prompt (1-4).' },
        model: { type: 'string', description: 'Image model id.' },
        visionModel: { type: 'string', description: 'Vision model used to plan the edit.' },
      },
      required: ['op'],
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const op = String(args?.op ?? '')
      if (!EDIT_OPS.includes(op)) throw new Error(`unknown op ${op}; expected one of ${EDIT_OPS.join(', ')}`)
      const result = await execute(op, args ?? {}, {
        baseVersionId: args?.versionId,
        config: readConfig(),
        signal: exec?.signal,
      })
      return { ...result, attachments: await admit(ctx, result.images) }
    },
    isConcurrencySafe: () => false,
    timeoutMs: 600000,
  }

  const history = {
    name: 'pixelfly_history',
    description: 'Read the Pixelfly version history: every version with its parent, operation, label and images. Can star or delete a version, clear the whole history, or set the style instruction that every later prompt inherits.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'star', 'delete', 'clear', 'setStyle'], description: 'What to do. Defaults to list.' },
        versionId: { type: 'string', description: 'For get, star or delete: which version. Defaults to the current one.' },
        starred: { type: 'boolean', description: 'For star: true to star, false to unstar.' },
        stylePrompt: { type: 'string', description: 'For setStyle: a style instruction applied to every prompt.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          versions: { type: 'array', items: { type: 'object' } },
          version: { type: 'object' },
          stylePrompt: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => renderText(value.message ?? JSON.stringify(value.versions ?? value.version, null, 2)),
    },
    async execute(args) {
      const action = args?.action ?? 'list'
      const workspace = getWorkspace()
      if (action === 'list') {
        if (workspace.versions.length === 0) {
          return { ok: true, versions: [], message: 'The history is empty. Use pixelfly_generate to make the first picture.' }
        }
        const lines = [
          `Style: ${workspace.stylePrompt || '(none)'}`,
          `Current: ${workspace.currentVersionId || '(empty)'}`,
          `Versions: ${workspace.versions.length}`,
        ]
        for (const version of workspace.versions) {
          lines.push(`  ${version.id} \u2190 ${version.parentId || '(root)'} \u00b7 ${version.op} \u00b7 ${version.label || '(no label)'}${version.starred ? ' \u00b7 starred' : ''} \u00b7 ${version.images?.length ?? 0} image(s)`)
        }
        return { ok: true, versions: workspace.versions, stylePrompt: workspace.stylePrompt ?? '', message: lines.join('\n') }
      }
      if (action === 'get') {
        const versionId = typeof args?.versionId === 'string' && args.versionId ? args.versionId : workspace.currentVersionId
        const version = (workspace.versions ?? []).find((row) => row.id === versionId)
        if (!version) return { ok: false, message: 'There is no such version.' }
        const lines = [
          `${version.id} \u00b7 ${version.op}`,
          `parent: ${version.parentId || '(root)'}`,
          `label: ${version.label || '(none)'}`,
          `prompt: ${version.prompt || '(none)'}`,
          `model: ${version.model || '(default)'}`,
          `images: ${(version.images ?? []).join(', ') || '(none)'}`,
          `notes: ${version.notes || '(none)'}`,
        ]
        return { ok: true, version, message: lines.join('\n') }
      }
      if (action === 'star') {
        const versionId = typeof args?.versionId === 'string' && args.versionId ? args.versionId : workspace.currentVersionId
        if (!versionId) return { ok: false, message: 'There are no versions to star yet.' }
        patchVersion(versionId, { starred: args?.starred !== false })
        return { ok: true, message: `${args?.starred === false ? 'Unstarred' : 'Starred'} ${versionId}` }
      }
      if (action === 'delete') {
        const versionId = typeof args?.versionId === 'string' && args.versionId ? args.versionId : workspace.currentVersionId
        if (!versionId) return { ok: false, message: 'There are no versions to delete.' }
        deleteVersion(versionId)
        return { ok: true, message: `Deleted ${versionId}` }
      }
      if (action === 'clear') {
        resetWorkspace()
        return { ok: true, message: 'Cleared the version history.' }
      }
      if (action === 'setStyle') {
        updateWorkspace({ stylePrompt: String(args?.stylePrompt ?? '') })
        return { ok: true, stylePrompt: String(args?.stylePrompt ?? ''), message: `Style set to: ${args?.stylePrompt || '(none)'}` }
      }
      throw new Error(`unknown action ${action}`)
    },
    isConcurrencySafe: () => false,
  }

  const configTool = {
    name: 'pixelfly_config',
    description: 'Read or update the Pixelfly configuration: upstream base URL and provider, API keys, default image and vision models, retry policy and size limits. Secrets are returned masked.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'setBaseUrl', 'setProvider', 'setDefaultModel', 'setVisionModel', 'addKey', 'removeKey', 'setRetry'], description: 'What to do. Defaults to read.' },
        baseUrl: { type: 'string', description: 'For setBaseUrl: the upstream base URL, e.g. https://token.sensenova.cn/v1' },
        provider: { type: 'string', enum: ['sensenova', 'openai', 'gemini'], description: 'For setProvider: which request shape the upstream speaks.' },
        model: { type: 'string', description: 'For setDefaultModel or setVisionModel: the model id.' },
        key: { type: 'string', description: 'For addKey: the API key value.' },
        label: { type: 'string', description: 'For addKey: a human label for the key.' },
        keyId: { type: 'string', description: 'For removeKey: the key id to drop.' },
        maxAttempts: { type: 'integer', description: 'For setRetry: total attempts including the first (1-12).' },
        baseDelayMs: { type: 'integer', description: 'For setRetry: first backoff delay in milliseconds.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, config: { type: 'object' }, message: { type: 'string' } },
        required: ['ok'],
      },
      render: (_args, value) => renderText(value.message ?? JSON.stringify(value.config, null, 2)),
    },
    async execute(args) {
      const action = args?.action ?? 'read'
      if (action === 'setBaseUrl') {
        if (typeof args.baseUrl !== 'string' || !/^https?:\/\//i.test(args.baseUrl)) throw new Error('baseUrl must be an http(s) URL')
        writeConfig({ upstream: { baseUrl: args.baseUrl.trim() } })
        return { ok: true, message: `Upstream base URL set to ${args.baseUrl.trim()}` }
      }
      if (action === 'setProvider') {
        if (!['sensenova', 'openai', 'gemini'].includes(args?.provider)) throw new Error('provider must be sensenova, openai or gemini')
        writeConfig({ upstream: { provider: args.provider } })
        return { ok: true, message: `Provider set to ${args.provider}` }
      }
      if (action === 'setDefaultModel') {
        if (typeof args.model !== 'string' || args.model.trim().length === 0) throw new Error('model is required')
        writeConfig({ models: { default: args.model.trim() } })
        return { ok: true, message: `Default image model set to ${args.model.trim()}` }
      }
      if (action === 'setVisionModel') {
        if (typeof args.model !== 'string' || args.model.trim().length === 0) throw new Error('model is required')
        writeConfig({ models: { visionDefault: args.model.trim() } })
        return { ok: true, message: `Default vision model set to ${args.model.trim()}` }
      }
      if (action === 'addKey') {
        if (typeof args.key !== 'string' || args.key.trim().length < 8) throw new Error('key is required')
        const config = readConfig()
        const id = `key-${Date.now().toString(36)}`
        const next = [...config.apiKeys, { id, label: args.label || `Key ${config.apiKeys.length + 1}`, enabled: true, weight: 1, key: args.key.trim() }]
        writeConfig({ apiKeys: next })
        return { ok: true, message: `Added API key ${maskKey(args.key.trim())} as ${id}` }
      }
      if (action === 'removeKey') {
        if (typeof args.keyId !== 'string') throw new Error('keyId is required')
        const config = readConfig()
        const next = config.apiKeys.filter((entry) => entry.id !== args.keyId)
        writeConfig({ apiKeys: next })
        return { ok: true, message: `Removed ${config.apiKeys.length - next.length} key(s)` }
      }
      if (action === 'setRetry') {
        const patch = {}
        if (Number.isFinite(Number(args.maxAttempts))) patch.maxAttempts = Math.max(1, Math.min(12, Math.round(Number(args.maxAttempts))))
        if (Number.isFinite(Number(args.baseDelayMs))) patch.baseDelayMs = Math.max(50, Math.round(Number(args.baseDelayMs)))
        writeConfig({ retry: patch })
        return { ok: true, message: `Retry policy updated: ${JSON.stringify(patch)}` }
      }
      const config = publicConfig()
      const lines = [
        `Config directory: ${pluginRoot()}`,
        `Upstream: ${config.upstream.baseUrl} (${config.upstream.provider})`,
        `Timeouts: ${config.upstream.timeoutMs} ms images, ${config.upstream.visionTimeoutMs} ms vision`,
        `Default image model: ${config.models.default}`,
        `Image models: ${config.models.items.map((item) => item.id).join(', ')}`,
        `Default vision model: ${config.models.visionDefault}`,
        `Vision models: ${config.models.visionItems.map((item) => item.id).join(', ')}`,
        `API keys: ${config.apiKeys.length}`,
        ...config.apiKeys.map((entry) => `  \u00b7 ${entry.id} ${entry.masked}${entry.enabled ? '' : ' (disabled)'}`),
        `Retry: up to ${config.retry.maxAttempts} attempts, base ${config.retry.baseDelayMs} ms, ceiling ${config.retry.maxDelayMs} ms, rotate ${config.retry.rotateKeys ? 'on' : 'off'}`,
        `Sizes: ${sizesFor().join(', ')}`,
      ]
      return { ok: true, config, message: lines.join('\n') }
    },
    isConcurrencySafe: () => false,
  }

  const status = {
    name: 'pixelfly_status',
    description: 'Report the Pixelfly upstream, configured keys (masked), retry policy, how many versions exist, supported sizes and the operation catalogue; optionally probe the upstream for its model list.',
    parameters: {
      type: 'object',
      properties: {
        probe: { type: 'boolean', description: 'Also call the upstream /models endpoint with the first usable key.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          baseUrl: { type: 'string' },
          keys: { type: 'array', items: { type: 'object' } },
          retry: { type: 'object' },
          models: { type: 'array', items: { type: 'object' } },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => renderText(value.message ?? ''),
    },
    async execute(args) {
      const config = readConfig()
      const keys = activeKeys(config).map((entry) => ({ id: entry.id, label: entry.label, masked: maskKey(entry.key), enabled: entry.enabled !== false }))
      const workspace = getWorkspace()
      const lines = [
        `Upstream: ${config.upstream.baseUrl} (${config.upstream.provider})`,
        `Keys: ${keys.length} configured`,
        ...keys.map((key) => `  \u00b7 ${key.label} ${key.masked}${key.enabled === false ? ' (disabled)' : ''}`),
        `Retry: up to ${config.retry?.maxAttempts ?? '?'} attempts, base ${config.retry?.baseDelayMs ?? '?'} ms`,
        `Versions: ${workspace.versions.length}`,
        `Sizes: ${sizesFor(config).join(', ')}`,
        `Operations: ${operationCatalog().map((row) => row.id).join(', ')}`,
      ]
      const value = { ok: true, baseUrl: config.upstream.baseUrl, keys, retry: config.retry, models: undefined }
      if (args?.probe === true) {
        try {
          value.models = await listModels({ config })
          lines.push(`Upstream models: ${value.models.map((row) => row.id).join(', ') || '(none)'}`)
        } catch (error) {
          value.error = error.message
          lines.push(`Probe error: ${error.message}`)
        }
      }
      value.message = lines.join('\n')
      return value
    },
    isConcurrencySafe: () => true,
  }

  return [generate, edit, history, configTool, status]
}
