// dsh-pixelfly — the workspace, the version tree and the asset store.
//
// There is one workspace and nothing else to choose between. A picture is never
// edited in place: every operation produces a new *version* whose `parentId`
// points at the version it was derived from, so the history is a tree and every
// branch is a choice the user made. That is what makes "compare with the previous
// one" and "go back and try a different direction" possible at all.
//
// Image bytes live in a content-addressed store keyed by sha256, so the same
// picture reached by two different paths is stored once.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { ensureDir, pluginRoot, workspaceRoot, writeFileAtomic } from './config.js'

export class StoreError extends Error {
  constructor(message, code = 'store') {
    super(message)
    this.name = 'StoreError'
    this.code = code
    this.status = code === 'not_found' ? 404 : 400
  }
}

// ---------------------------------------------------------------------------
// assets
// ---------------------------------------------------------------------------

function assetsRoot() {
  return path.join(pluginRoot(), 'assets')
}

function assetDir(id) {
  return path.join(assetsRoot(), id.slice(0, 2))
}

function assetPath(id) {
  return path.join(assetDir(id), id)
}

/**
 * Store image bytes once, keyed by their sha256.
 *
 * The id is the digest itself, which makes the store self-verifying: a caller
 * that has an id can check that what came back is what was stored.
 */
export function saveAsset(buffer, options = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (bytes.length === 0) throw new StoreError('Cannot store an empty image', 'empty')
  const id = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 40)
  const target = assetPath(id)
  if (!fs.existsSync(target)) {
    ensureDir(assetDir(id))
    writeFileAtomic(target, bytes, 0o600)
  }
  return {
    id,
    bytes: bytes.length,
    mediaType: options.mediaType ?? 'image/png',
    width: options.width ?? 0,
    height: options.height ?? 0,
  }
}

export function readAsset(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8,64}$/.test(id)) {
    throw new StoreError('Malformed asset id', 'bad_id')
  }
  const target = assetPath(id)
  let stat = null
  try { stat = fs.statSync(target) } catch { stat = null }
  if (stat === null || !stat.isFile()) throw new StoreError('That image is no longer on disk', 'not_found')
  return fs.readFileSync(target)
}

/** Drop assets the workspace no longer references. */
export function collectGarbage() {
  const referenced = new Set()
  const workspace = readWorkspaceFile()
  if (workspace !== null) {
    if (workspace.cover) referenced.add(workspace.cover)
    for (const version of workspace.versions) {
      for (const id of version.images ?? []) referenced.add(id)
      if (version.thumb) referenced.add(version.thumb)
    }
  }
  let removed = 0
  let root = ''
  try { root = assetsRoot() } catch { return { removed: 0 } }
  let dirs = []
  try { dirs = fs.readdirSync(root) } catch { return { removed: 0 } }
  for (const dir of dirs) {
    const full = path.join(root, dir)
    let files = []
    try { files = fs.readdirSync(full) } catch { continue }
    for (const file of files) {
      if (referenced.has(file)) continue
      try { fs.unlinkSync(path.join(full, file)); removed += 1 } catch { /* keep going */ }
    }
  }
  return { removed }
}

// ---------------------------------------------------------------------------
// the workspace
// ---------------------------------------------------------------------------

/** There is exactly one workspace; it is created on first use. */
const WORKSPACE_ID = 'workspace'

function workspaceDir() {
  return path.join(workspaceRoot(), WORKSPACE_ID)
}

function workspaceFile() {
  return path.join(workspaceDir(), 'record.json')
}

function newId(prefix = 'p') {
  const stamp = Date.now().toString(36)
  const noise = crypto.randomBytes(4).toString('hex')
  return `${prefix}-${stamp}-${noise}`
}

function emptyWorkspace() {
  const now = new Date().toISOString()
  return {
    id: WORKSPACE_ID,
    createdAt: now,
    updatedAt: now,
    stylePrompt: '',
    models: { image: '', vision: '' },
    cover: '',
    currentVersionId: '',
    versions: [],
  }
}

function readWorkspaceFile() {
  let text = ''
  try {
    text = fs.readFileSync(workspaceFile(), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed.versions)) parsed.versions = []
    // Older files carried a chat log that nothing rendered; dropping it here means the
    // next write shrinks the file instead of carrying the dead weight forward.
    delete parsed.conversation
    return parsed
  } catch {
    return null
  }
}

function writeWorkspace(workspace) {
  workspace.updatedAt = new Date().toISOString()
  ensureDir(workspaceDir())
  writeFileAtomic(workspaceFile(), `${JSON.stringify(workspace, null, 2)}\n`, 0o600)
  return workspace
}

/**
 * The one workspace everything runs in.
 *
 * Keeping a single container means the version tree is the only thing that grows,
 * and an operation never has to ask which container it belongs to.
 */
function ensureWorkspace() {
  const existing = readWorkspaceFile()
  if (existing !== null) return existing
  return writeWorkspace(emptyWorkspace())
}

/** The workspace, always present. */
export function getWorkspace() {
  return ensureWorkspace()
}

/** Wipe the workspace's history but keep its settings. */
export function resetWorkspace() {
  const workspace = ensureWorkspace()
  workspace.versions = []
  workspace.currentVersionId = ''
  workspace.cover = ''
  return writeWorkspace(workspace)
}

/** Patch the workspace's own settings: style prompt, models, current version, cover. */
export function updateWorkspace(patch = {}) {
  const workspace = ensureWorkspace()
  if (typeof patch.stylePrompt === 'string') workspace.stylePrompt = patch.stylePrompt.slice(0, 4000)
  if (typeof patch.cover === 'string') workspace.cover = patch.cover
  if (typeof patch.currentVersionId === 'string') workspace.currentVersionId = patch.currentVersionId
  if (patch.models && typeof patch.models === 'object') {
    if (typeof patch.models.image === 'string') workspace.models.image = patch.models.image
    if (typeof patch.models.vision === 'string') workspace.models.vision = patch.models.vision
  }
  return writeWorkspace(workspace)
}

// ---------------------------------------------------------------------------
// versions
// ---------------------------------------------------------------------------

/**
 * Append a version under `parentId`.
 *
 * `images` is a list of asset ids. The first image of a successful version
 * becomes the workspace's cover unless one was set explicitly.
 */
export function addVersion(input = {}) {
  const workspace = ensureWorkspace()
  const parentId = typeof input.parentId === 'string' ? input.parentId : ''
  if (parentId.length > 0 && !workspace.versions.some((version) => version.id === parentId)) {
    throw new StoreError('The parent version does not exist', 'bad_parent')
  }
  const version = {
    id: newId('v'),
    parentId,
    createdAt: new Date().toISOString(),
    op: typeof input.op === 'string' ? input.op : 'text2image',
    label: typeof input.label === 'string' ? input.label.slice(0, 160) : '',
    prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, 12000) : '',
    model: typeof input.model === 'string' ? input.model : '',
    visionModel: typeof input.visionModel === 'string' ? input.visionModel : '',
    params: input.params && typeof input.params === 'object' ? input.params : {},
    images: Array.isArray(input.images) ? input.images.filter((value) => typeof value === 'string') : [],
    thumb: typeof input.thumb === 'string' ? input.thumb : '',
    notes: typeof input.notes === 'string' ? input.notes.slice(0, 4000) : '',
    starred: input.starred === true,
    status: input.status === 'failed' ? 'failed' : 'ok',
    error: typeof input.error === 'string' ? input.error.slice(0, 2000) : '',
    meta: input.meta && typeof input.meta === 'object' ? input.meta : {},
  }
  workspace.versions.push(version)
  workspace.currentVersionId = version.id
  if (!workspace.cover && version.images.length > 0) workspace.cover = version.images[0]
  writeWorkspace(workspace)
  return { version }
}

export function getVersion(versionId) {
  const workspace = ensureWorkspace()
  const version = workspace.versions.find((row) => row.id === versionId)
  if (!version) throw new StoreError('No such version', 'not_found')
  return version
}

/**
 * Remove a version from the tree.
 *
 * Children are re-parented onto the removed node's parent, so deleting an
 * intermediate step does not orphan the branches below it.
 */
export function deleteVersion(versionId) {
  const workspace = ensureWorkspace()
  const target = workspace.versions.find((version) => version.id === versionId)
  if (!target) throw new StoreError('No such version', 'not_found')
  workspace.versions = workspace.versions.filter((version) => version.id !== versionId)
  for (const version of workspace.versions) {
    if (version.parentId === versionId) version.parentId = target.parentId ?? ''
  }
  if (workspace.currentVersionId === versionId) {
    workspace.currentVersionId = workspace.versions[workspace.versions.length - 1]?.id ?? ''
  }
  if (workspace.cover && target.images.includes(workspace.cover)) workspace.cover = ''
  writeWorkspace(workspace)
  return { ok: true }
}

export function patchVersion(versionId, patch = {}) {
  const workspace = ensureWorkspace()
  const version = workspace.versions.find((row) => row.id === versionId)
  if (!version) throw new StoreError('No such version', 'not_found')
  if (typeof patch.label === 'string') version.label = patch.label.slice(0, 160)
  if (typeof patch.notes === 'string') version.notes = patch.notes.slice(0, 4000)
  if (typeof patch.starred === 'boolean') version.starred = patch.starred
  if (typeof patch.status === 'string') version.status = patch.status === 'failed' ? 'failed' : 'ok'
  writeWorkspace(workspace)
  return { version }
}

// ---------------------------------------------------------------------------
// prompt library
// ---------------------------------------------------------------------------

function libraryPath() {
  return path.join(pluginRoot(), 'library.json')
}

const SEED_PROMPTS = [
  { title: 'Soft studio portrait', text: 'studio portrait of a person, soft key light from the left, seamless warm grey backdrop, 85mm lens, shallow depth of field, natural skin texture' },
  { title: 'Product on stone', text: 'product photograph on a polished dark stone surface, single softbox reflection, muted background, crisp focus, commercial catalogue style' },
  { title: 'Isometric room', text: 'isometric cutaway of a small room, warm afternoon light through one window, cosy furniture, clean vector-like shading, soft palette' },
  { title: 'Ink wash landscape', text: 'traditional ink wash landscape, distant mountains fading into mist, a lone pine on a rock, restrained palette, generous negative space' },
  { title: 'Editorial flat lay', text: 'overhead flat lay on a linen surface, three objects arranged on a diagonal, natural window light, soft shadows, magazine editorial style' },
  { title: 'Cinematic still', text: 'cinematic film still, teal and amber grade, anamorphic flare, deep shadows, subject lit from behind, 2.39:1 composition' },
]

export function readLibrary() {
  try {
    const parsed = JSON.parse(fs.readFileSync(libraryPath(), 'utf8'))
    if (Array.isArray(parsed?.prompts)) return parsed
  } catch { /* fall through to the seed */ }
  const seeded = {
    prompts: SEED_PROMPTS.map((row, index) => ({
      id: `seed-${index + 1}`,
      title: row.title,
      text: row.text,
      builtin: true,
      createdAt: new Date(0).toISOString(),
    })),
  }
  try { writeFileAtomic(libraryPath(), `${JSON.stringify(seeded, null, 2)}\n`, 0o600) } catch { /* read-only home */ }
  return seeded
}

export function addLibraryPrompt(input = {}) {
  const library = readLibrary()
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (text.length === 0) throw new StoreError('A prompt needs text', 'empty')
  // An entry may remember the picture it was distilled from, so the gallery can
  // show what the prompt looks like instead of only what it says.
  const imageId = typeof input.imageId === 'string' && input.imageId.length > 0 ? input.imageId : ''
  const row = {
    id: newId('pl'),
    title: typeof input.title === 'string' && input.title.trim().length > 0 ? input.title.trim().slice(0, 120) : text.slice(0, 60),
    text: text.slice(0, 12000),
    builtin: false,
    imageId,
    createdAt: new Date().toISOString(),
  }
  library.prompts.unshift(row)
  writeFileAtomic(libraryPath(), `${JSON.stringify(library, null, 2)}\n`, 0o600)
  return row
}

export function removeLibraryPrompt(id) {
  const library = readLibrary()
  const before = library.prompts.length
  library.prompts = library.prompts.filter((row) => row.id !== id || row.builtin === true)
  if (library.prompts.length === before) throw new StoreError('No such prompt', 'not_found')
  writeFileAtomic(libraryPath(), `${JSON.stringify(library, null, 2)}\n`, 0o600)
  return { ok: true }
}
