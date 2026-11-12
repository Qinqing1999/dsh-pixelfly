// dsh-pixelfly — the workspace record, the version tree and the asset store.
//
// A picture is never edited in place. Every operation produces a new *version*
// whose `parentId` points at the version it was derived from, so the whole history
// is a forest: one root per "idea", and every branch is a choice the user made.
// That is what makes "compare with the previous one" and "go back and try a
// different direction" possible at all.
//
// Image bytes live in a content-addressed store keyed by sha256, so the same
// picture reached by two different paths is stored once, and duplicating a
// record copies no bytes.

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

export function assetsRoot() {
  return path.join(pluginRoot(), 'assets')
}

function assetDir(id) {
  return path.join(assetsRoot(), id.slice(0, 2))
}

export function assetPath(id) {
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

export function hasAsset(id) {
  try {
    return fs.statSync(assetPath(id)).isFile()
  } catch {
    return false
  }
}

/** Drop assets no record references any more. */
export function collectGarbage() {
  const referenced = new Set()
  for (const summary of listRecords()) {
    const record = readRecordFile(summary.id)
    if (record === null) continue
    if (record.cover) referenced.add(record.cover)
    for (const version of record.versions) {
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
// record files
// ---------------------------------------------------------------------------

function recordDir(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,40}$/.test(id)) {
    throw new StoreError('Malformed record id', 'bad_id')
  }
  return path.join(workspaceRoot(), id)
}

function recordFile(id) {
  return path.join(recordDir(id), 'record.json')
}

export function newId(prefix = 'p') {
  const stamp = Date.now().toString(36)
  const noise = crypto.randomBytes(4).toString('hex')
  return `${prefix}-${stamp}-${noise}`
}

function emptyRecord(name) {
  const now = new Date().toISOString()
  return {
    id: newId('prj'),
    name: typeof name === 'string' && name.trim().length > 0 ? name.trim().slice(0, 120) : 'Untitled record',
    description: '',
    favorite: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
    stylePrompt: '',
    models: { image: '', vision: '' },
    cover: '',
    currentVersionId: '',
    versions: [],
    conversation: [],
  }
}

function readRecordFile(id) {
  let text = ''
  try {
    text = fs.readFileSync(recordFile(id), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed.versions)) parsed.versions = []
    if (!Array.isArray(parsed.conversation)) parsed.conversation = []
    return parsed
  } catch {
    return null
  }
}

function writeRecord(record) {
  record.updatedAt = new Date().toISOString()
  ensureDir(recordDir(record.id))
  writeFileAtomic(recordFile(record.id), `${JSON.stringify(record, null, 2)}\n`, 0o600)
  return record
}

/** The single workspace id. There is exactly one, created on first use. */
export const WORKSPACE_ID = 'workspace'

/**
 * The one workspace everything runs in.
 *
 * Keeping a single record means the version tree is the only thing that grows, and
 * an operation never has to ask which container it belongs to.
 */
export function ensureWorkspace() {
  const existing = readRecordFile(WORKSPACE_ID)
  if (existing !== null) return existing
  const now = new Date().toISOString()
  const workspace = {
    ...emptyRecord('Workspace'),
    id: WORKSPACE_ID,
    name: 'Workspace',
    createdAt: now,
    updatedAt: now,
  }
  writeRecord(workspace)
  return workspace
}

/** The workspace, always present. */
export function getWorkspace() {
  return ensureWorkspace()
}

/** Wipe the workspace's history but keep its settings. */
export function resetWorkspace() {
  const workspace = ensureWorkspace()
  workspace.versions = []
  workspace.conversation = []
  workspace.currentVersionId = ''
  workspace.cover = ''
  writeRecord(workspace)
  return workspace
}

/** Create a record and return it. */
export function createRecord(input = {}) {
  const record = emptyRecord(input.name)
  if (typeof input.description === 'string') record.description = input.description.slice(0, 2000)
  if (typeof input.stylePrompt === 'string') record.stylePrompt = input.stylePrompt.slice(0, 4000)
  if (input.models && typeof input.models === 'object') {
    record.models.image = typeof input.models.image === 'string' ? input.models.image : ''
    record.models.vision = typeof input.models.vision === 'string' ? input.models.vision : ''
  }
  writeRecord(record)
  return record
}

export function getRecord(id) {
  const record = readRecordFile(id)
  if (record === null) throw new StoreError('No such record', 'not_found')
  return record
}

/** A summary row for the library view: no version payloads. */
export function summariseRecord(record) {
  const versions = record.versions ?? []
  const live = versions.filter((version) => version.status !== 'failed')
  const latest = live[live.length - 1]
  const cover = record.cover || latest?.images?.[0] || latest?.thumb || ''
  return {
    id: record.id,
    name: record.name,
    description: record.description ?? '',
    favorite: record.favorite === true,
    archived: record.archived === true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    cover,
    versionCount: versions.length,
    imageCount: versions.reduce((total, version) => total + (version.images?.length ?? 0), 0),
    currentVersionId: record.currentVersionId ?? '',
    models: record.models ?? { image: '', vision: '' },
    lastPrompt: latest?.prompt ?? '',
  }
}

/** Every record, newest first, with optional search/filter. */
export function listRecords(query = {}) {
  let ids = []
  try {
    ids = fs.readdirSync(workspaceRoot()).filter((name) => /^prj-/.test(name))
  } catch {
    return []
  }
  const rows = []
  for (const id of ids) {
    const record = readRecordFile(id)
    if (record === null) continue
    if (query.archived !== true && record.archived === true) continue
    if (query.archived === true && record.archived !== true) continue
    if (query.favorite === true && record.favorite !== true) continue
    if (typeof query.search === 'string' && query.search.trim().length > 0) {
      const needle = query.search.trim().toLowerCase()
      const haystack = `${record.name}\n${record.description ?? ''}\n${(record.versions ?? []).map((version) => version.prompt ?? '').join('\n')}`.toLowerCase()
      if (!haystack.includes(needle)) continue
    }
    rows.push(summariseRecord(record))
  }
  rows.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
  return rows
}

/** Patch the mutable record fields. */
export function updateRecord(id, patch = {}) {
  const record = getRecord(id)
  if (typeof patch.name === 'string' && patch.name.trim().length > 0) record.name = patch.name.trim().slice(0, 120)
  if (typeof patch.description === 'string') record.description = patch.description.slice(0, 2000)
  if (typeof patch.stylePrompt === 'string') record.stylePrompt = patch.stylePrompt.slice(0, 4000)
  if (typeof patch.favorite === 'boolean') record.favorite = patch.favorite
  if (typeof patch.archived === 'boolean') record.archived = patch.archived
  if (typeof patch.cover === 'string') record.cover = patch.cover
  if (typeof patch.currentVersionId === 'string') record.currentVersionId = patch.currentVersionId
  if (patch.models && typeof patch.models === 'object') {
    if (typeof patch.models.image === 'string') record.models.image = patch.models.image
    if (typeof patch.models.vision === 'string') record.models.vision = patch.models.vision
  }
  return writeRecord(record)
}

/** Soft-delete: the directory is removed, so a restore needs a backup. */
export function deleteRecord(id) {
  const dir = recordDir(id)
  getRecord(id)
  fs.rmSync(dir, { recursive: true, force: true })
  return { id, deleted: true }
}

/** Copy a record, keeping the version tree and sharing its assets. */
export function duplicateRecord(id) {
  const source = getRecord(id)
  const copy = JSON.parse(JSON.stringify(source))
  copy.id = newId('prj')
  copy.name = `${source.name} copy`.slice(0, 120)
  copy.createdAt = new Date().toISOString()
  copy.updatedAt = copy.createdAt
  copy.favorite = false
  const remap = new Map()
  for (const version of copy.versions) {
    const next = newId('v')
    remap.set(version.id, next)
    version.id = next
  }
  for (const version of copy.versions) {
    version.parentId = version.parentId ? remap.get(version.parentId) ?? '' : ''
  }
  copy.currentVersionId = remap.get(source.currentVersionId) ?? copy.versions[copy.versions.length - 1]?.id ?? ''
  writeRecord(copy)
  return copy
}

// ---------------------------------------------------------------------------
// versions
// ---------------------------------------------------------------------------

/**
 * Append a version under `parentId`.
 *
 * `images` is a list of asset ids. The first image of a successful version
 * becomes the record's cover unless one was set explicitly.
 */
export function addVersion(recordId, input = {}) {
  const record = getRecord(recordId)
  const parentId = typeof input.parentId === 'string' ? input.parentId : ''
  if (parentId.length > 0 && !record.versions.some((version) => version.id === parentId)) {
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
  record.versions.push(version)
  record.currentVersionId = version.id
  if (!record.cover && version.images.length > 0) record.cover = version.images[0]
  writeRecord(record)
  return { version, record: summariseRecord(record) }
}

export function getVersion(recordId, versionId) {
  const record = getRecord(recordId)
  const version = record.versions.find((row) => row.id === versionId)
  if (!version) throw new StoreError('No such version', 'not_found')
  return version
}

/** Walk from a version up to its root. */
export function ancestry(recordId, versionId) {
  const record = getRecord(recordId)
  const byId = new Map(record.versions.map((version) => [version.id, version]))
  const chain = []
  let cursor = byId.get(versionId)
  const seen = new Set()
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    chain.push(cursor)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  return chain.reverse()
}

/**
 * Remove a version from the tree.
 *
 * Children are re-parented onto the removed node's parent, so deleting an
 * intermediate step does not orphan the branches below it.
 */
export function deleteVersion(recordId, versionId) {
  const record = getRecord(recordId)
  const target = record.versions.find((version) => version.id === versionId)
  if (!target) throw new StoreError('No such version', 'not_found')
  record.versions = record.versions.filter((version) => version.id !== versionId)
  for (const version of record.versions) {
    if (version.parentId === versionId) version.parentId = target.parentId ?? ''
  }
  if (record.currentVersionId === versionId) {
    record.currentVersionId = record.versions[record.versions.length - 1]?.id ?? ''
  }
  if (record.cover && target.images.includes(record.cover)) record.cover = ''
  writeRecord(record)
  return { record: summariseRecord(record) }
}

export function patchVersion(recordId, versionId, patch = {}) {
  const record = getRecord(recordId)
  const version = record.versions.find((row) => row.id === versionId)
  if (!version) throw new StoreError('No such version', 'not_found')
  if (typeof patch.label === 'string') version.label = patch.label.slice(0, 160)
  if (typeof patch.notes === 'string') version.notes = patch.notes.slice(0, 4000)
  if (typeof patch.starred === 'boolean') version.starred = patch.starred
  if (typeof patch.status === 'string') version.status = patch.status === 'failed' ? 'failed' : 'ok'
  writeRecord(record)
  return { version, record: summariseRecord(record) }
}

// ---------------------------------------------------------------------------
// conversation
// ---------------------------------------------------------------------------

/** Append one line to the record's conversation log. */
export function appendMessage(recordId, message = {}) {
  const record = getRecord(recordId)
  const row = {
    id: newId('m'),
    at: new Date().toISOString(),
    role: message.role === 'user' ? 'user' : 'assistant',
    kind: typeof message.kind === 'string' ? message.kind : 'text',
    text: typeof message.text === 'string' ? message.text.slice(0, 8000) : '',
    versionId: typeof message.versionId === 'string' ? message.versionId : '',
    images: Array.isArray(message.images) ? message.images.filter((value) => typeof value === 'string').slice(0, 8) : [],
    ok: message.ok !== false,
  }
  record.conversation.push(row)
  if (record.conversation.length > 400) record.conversation = record.conversation.slice(-400)
  writeRecord(record)
  return row
}

export function clearConversation(recordId) {
  const record = getRecord(recordId)
  record.conversation = []
  writeRecord(record)
  return { ok: true }
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
  const row = {
    id: newId('pl'),
    title: typeof input.title === 'string' && input.title.trim().length > 0 ? input.title.trim().slice(0, 120) : text.slice(0, 60),
    text: text.slice(0, 12000),
    builtin: false,
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
