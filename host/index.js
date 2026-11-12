// dsh-pixelfly — Host half.
//
// Registers the model-facing tools plus the HTTP routes the settings page and the
// workspace talk to. Named Web routes carry no server-wide auth, so every route below
// sits behind a Host/Origin fence, DSH's own connection admission for browser
// requests, and a per-process Bearer token the page bootstraps from a token route.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  activeKeys,
  baseUrl,
  imagesRoot,
  maskKey,
  outputDir,
  pluginRoot,
  workspaceRoot,
  publicConfig,
  readConfig,
  readState,
  sizesFor,
  writeConfig,
} from './config.js'
import { createTools } from './tools.js'
import { KeyPool, listModels, UpstreamError } from './upstream.js'
import { decodeUpload, execute, publicWorkspace } from './session.js'
import {
  ASSET_KIND_LIST,
  COLOUR_MODE_LIST,
  ELEMENT_PRESET_LIST,
  FUSION_MODE_LIST,
  OperationError,
  expandVariables,
  operationCatalog,
  recogniseText,
} from './operations.js'
import {
  addLibraryPrompt,
  addVersion,
  ancestry,
  appendMessage,
  clearConversation,
  collectGarbage,
  deleteVersion,
  getVersion,
  getWorkspace,
  patchVersion,
  resetWorkspace,
  readAsset,
  readLibrary,
  removeLibraryPrompt,
  saveAsset,
  updateRecord,
} from './store.js'
import { probe } from './raster.js'
import { createZip } from './zip.js'

export const inject = ['tools']

const ROUTE_BASE = '/pixelfly/api'
const TOKEN_ROUTE = `${ROUTE_BASE}/token`

const TOKEN_MIN_LENGTH = 32
const TOKEN_FILE = 'http.token'

// --- request fencing ---------------------------------------------------------------------------

function headerOf(headers, name) {
  if (!headers) return undefined
  const value = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(value)) return value.join(', ')
  return typeof value === 'string' ? value : undefined
}

function authorityOf(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try { return new URL(`http://${value}`) } catch { return undefined }
}

function isLoopbackHostname(hostname) {
  const normal = String(hostname || '').toLowerCase()
  if (normal === 'localhost' || normal === '::1' || normal === '[::1]') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normal)
  if (!match) return false
  const octets = match.slice(1).map(Number)
  return octets.every((part) => part >= 0 && part <= 255) && octets[0] === 127
}

function createHttpAuth(ctx, policy) {
  const override = typeof process.env.PIXELFLY_HTTP_TOKEN === 'string' ? process.env.PIXELFLY_HTTP_TOKEN.trim() : ''
  const token = override.length >= TOKEN_MIN_LENGTH ? override : randomBytes(32).toString('hex')
  let tokenFile = null
  try {
    fs.mkdirSync(pluginRoot(), { recursive: true })
    tokenFile = path.join(pluginRoot(), TOKEN_FILE)
    fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
    try { fs.chmodSync(tokenFile, 0o600) } catch { /* Windows ignores POSIX modes */ }
  } catch { tokenFile = null }
  return {
    token,
    tokenFile,
    policy,
    connection: () => {
      try {
        const connection = ctx.get('connection')
        return connection && typeof connection.requestRejection === 'function' ? connection : undefined
      } catch {
        return undefined
      }
    },
  }
}

// The fence is loopback-only by default. A Harness deliberately served on a LAN
// address has to widen it explicitly: `allowNonLoopback: true` plus the
// `trustedHosts` entries it is actually reached by.
function makePolicy(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const trustedHosts = new Set()
  if (Array.isArray(raw.trustedHosts)) {
    for (const entry of raw.trustedHosts) {
      if (typeof entry !== 'string') continue
      const value = entry.trim().toLowerCase()
      if (value.length > 0) trustedHosts.add(value)
    }
  }
  return { allowNonLoopback: raw.allowNonLoopback === true, trustedHosts }
}

function hostAllowed(req, policy) {
  const authority = authorityOf(headerOf(req.headers, 'host'))
  if (!authority) return false
  if (isLoopbackHostname(authority.hostname)) return true
  if (!policy.allowNonLoopback) return false
  return policy.trustedHosts.has(authority.host.toLowerCase())
}

function originAllowed(req, policy) {
  const origin = headerOf(req.headers, 'origin')
  if (origin === undefined) return true
  let parsed
  try { parsed = new URL(origin) } catch { return false }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const authority = authorityOf(headerOf(req.headers, 'host'))
  if (!authority) return false
  if (parsed.host.toLowerCase() === authority.host.toLowerCase()) return true
  if (isLoopbackHostname(parsed.hostname)) return true
  return policy.allowNonLoopback && policy.trustedHosts.has(parsed.host.toLowerCase())
}

function isBrowserRequest(req) {
  const site = headerOf(req.headers, 'sec-fetch-site')
  if (site !== undefined) return site !== 'none'
  return headerOf(req.headers, 'origin') !== undefined || headerOf(req.headers, 'referer') !== undefined
}

function bearerOf(req) {
  const value = headerOf(req.headers, 'authorization')
  if (typeof value !== 'string') return undefined
  const match = /^Bearer[ \t]+([A-Za-z0-9._~+/=-]{8,4096})$/i.exec(value.trim())
  return match ? match[1] : undefined
}

function constantEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('vary', 'Origin')
  res.end(JSON.stringify(payload))
}

function sendBinary(res, status, mediaType, bytes, options = {}) {
  res.statusCode = status
  res.setHeader('content-type', mediaType)
  res.setHeader('content-length', String(bytes.length))
  res.setHeader('cache-control', options.cacheControl ?? 'private, max-age=300')
  res.setHeader('x-content-type-options', 'nosniff')
  if (typeof options.disposition === 'string') res.setHeader('content-disposition', options.disposition)
  res.end(bytes)
}

function rejectRequest(req, auth, options = {}) {
  const requireToken = options.requireToken !== false
  if (!hostAllowed(req, auth.policy)) return 403
  if (!originAllowed(req, auth.policy)) return 403
  if (options.requireConnection === 'always' || isBrowserRequest(req)) {
    const connection = auth.connection()
    if (!connection) return 401
    const rejection = connection.requestRejection({ headers: req.headers })
    if (rejection === 401 || rejection === 403) return rejection
  }
  if (requireToken && !constantEquals(bearerOf(req), auth.token)) return 401
  return undefined
}

function guarded(handler, auth, options = {}) {
  return async (req, res) => {
    const rejection = rejectRequest(req, auth, options)
    if (rejection !== undefined) {
      sendJson(res, rejection, {
        ok: false,
        error: rejection === 401 ? 'unauthorized' : 'forbidden',
        hint: rejection === 401 && options.requireToken !== false
          ? 'send Authorization: Bearer <token> from GET /pixelfly/api/token'
          : undefined,
      })
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      if (res.headersSent) {
        try { res.end() } catch { /* already gone */ }
        return
      }
      const status = Number.isFinite(error?.status) && error.status >= 400 && error.status < 600
        ? error.status
        : error instanceof OperationError ? 400 : 500
      sendJson(res, status, {
        ok: false,
        error: error?.message ?? String(error),
        code: error?.code,
        trace: error?.trace,
        attempts: error?.attempts,
      })
    }
  }
}

async function readJsonBody(req, limitBytes = 2 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new UpstreamError('Request body is too large.', { code: 'body_too_large', status: 413 })
    chunks.push(chunk)
  }
  if (total === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new UpstreamError('Request body is not valid JSON.', { code: 'bad_json', status: 400 })
  }
}

function searchOf(req) {
  return new URL(req.url ?? '/', 'http://localhost').searchParams
}

// --- settings routes ---------------------------------------------------------------------------

function tokenRoute(auth) {
  return guarded(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'GET only' })
    sendJson(res, 200, { ok: true, token: auth.token })
  }, auth, { requireToken: false, requireConnection: 'always' })
}

function configRoute(auth) {
  return guarded(async (req, res) => {
    if (req.method === 'GET') {
      const config = readConfig()
      const state = readState()
      sendJson(res, 200, {
        ok: true,
        config: publicConfig(config),
        resolved: {
          baseUrl: baseUrl(config),
          outputDir: outputDir(config),
          imageRoot: imagesRoot(),
          workspaceRoot: workspaceRoot(),
          keyCount: activeKeys(config).length,
        },
        operations: operationCatalog(),
        presets: {
          element: ELEMENT_PRESET_LIST,
          asset: ASSET_KIND_LIST,
          colour: COLOUR_MODE_LIST,
          fusion: FUSION_MODE_LIST,
        },
        stats: state.lastRun ?? null,
      })
      return
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET or POST only' })
    const body = await readJsonBody(req)
    const patch = {}
    if (body.upstream && typeof body.upstream === 'object') {
      const upstream = {}
      if (typeof body.upstream.baseUrl === 'string') {
        if (!/^https?:\/\//i.test(body.upstream.baseUrl.trim())) {
          return sendJson(res, 400, { ok: false, error: 'baseUrl must be an http(s) URL' })
        }
        upstream.baseUrl = body.upstream.baseUrl.trim()
      }
      if (typeof body.upstream.provider === 'string' && ['sensenova', 'openai', 'gemini'].includes(body.upstream.provider)) {
        upstream.provider = body.upstream.provider
      }
      if (Number.isFinite(Number(body.upstream.timeoutMs))) {
        upstream.timeoutMs = Math.max(5000, Math.min(600000, Math.round(Number(body.upstream.timeoutMs))))
      }
      if (Number.isFinite(Number(body.upstream.visionTimeoutMs))) {
        upstream.visionTimeoutMs = Math.max(5000, Math.min(600000, Math.round(Number(body.upstream.visionTimeoutMs))))
      }
      if (Object.keys(upstream).length > 0) patch.upstream = upstream
    }
    if (body.retry && typeof body.retry === 'object') {
      const retry = {}
      if (Number.isFinite(Number(body.retry.maxAttempts))) retry.maxAttempts = Math.max(1, Math.min(12, Math.round(Number(body.retry.maxAttempts))))
      if (Number.isFinite(Number(body.retry.baseDelayMs))) retry.baseDelayMs = Math.max(50, Math.min(60000, Math.round(Number(body.retry.baseDelayMs))))
      if (Number.isFinite(Number(body.retry.maxDelayMs))) retry.maxDelayMs = Math.max(1000, Math.min(120000, Math.round(Number(body.retry.maxDelayMs))))
      if (Number.isFinite(Number(body.retry.cooldownMs))) retry.cooldownMs = Math.max(1000, Math.min(600000, Math.round(Number(body.retry.cooldownMs))))
      if (typeof body.retry.rotateKeys === 'boolean') retry.rotateKeys = body.retry.rotateKeys
      if (typeof body.retry.respectRetryAfter === 'boolean') retry.respectRetryAfter = body.retry.respectRetryAfter
      if (Object.keys(retry).length > 0) patch.retry = retry
    }
    if (body.models && typeof body.models === 'object') {
      const models = {}
      if (typeof body.models.default === 'string' && body.models.default.trim().length > 0) models.default = body.models.default.trim()
      if (Array.isArray(body.models.items)) {
        models.items = body.models.items
          .filter((row) => row && typeof row.id === 'string' && row.id.trim().length > 0)
          .map((row) => ({ id: row.id.trim(), label: typeof row.label === 'string' && row.label.trim().length > 0 ? row.label.trim() : row.id.trim() }))
      }
      if (typeof body.models.visionDefault === 'string' && body.models.visionDefault.trim().length > 0) models.visionDefault = body.models.visionDefault.trim()
      if (Array.isArray(body.models.visionItems)) {
        models.visionItems = body.models.visionItems
          .filter((row) => row && typeof row.id === 'string' && row.id.trim().length > 0)
          .map((row) => ({ id: row.id.trim(), label: typeof row.label === 'string' && row.label.trim().length > 0 ? row.label.trim() : row.id.trim() }))
      }
      if (Object.keys(models).length > 0) patch.models = models
    }
    if (body.request && typeof body.request === 'object') {
      const request = {}
      if (typeof body.request.size === 'string' && body.request.size.trim().length > 0) request.size = body.request.size.trim()
      if (Number.isFinite(Number(body.request.n))) request.n = Math.max(1, Math.min(4, Math.round(Number(body.request.n))))
      if (typeof body.request.watermark === 'boolean') request.watermark = body.request.watermark
      if (typeof body.request.promptExtend === 'boolean') request.promptExtend = body.request.promptExtend
      if (Object.keys(request).length > 0) patch.request = request
    }
    if (body.output && typeof body.output === 'object') {
      const output = {}
      if (typeof body.output.dir === 'string') output.dir = body.output.dir.trim()
      if (typeof body.output.saveToDisk === 'boolean') output.saveToDisk = body.output.saveToDisk
      if (Number.isFinite(Number(body.output.keepFiles))) output.keepFiles = Math.max(0, Math.min(10000, Math.round(Number(body.output.keepFiles))))
      if (Object.keys(output).length > 0) patch.output = output
    }
    if (body.limits && typeof body.limits === 'object') {
      const limits = {}
      if (Number.isFinite(Number(body.limits.maxBatch))) limits.maxBatch = Math.max(2, Math.min(50, Math.round(Number(body.limits.maxBatch))))
      if (Number.isFinite(Number(body.limits.visionMaxSide))) limits.visionMaxSide = Math.max(256, Math.min(1536, Math.round(Number(body.limits.visionMaxSide))))
      if (Object.keys(limits).length > 0) patch.limits = limits
    }
    const next = writeConfig(patch)
    sendJson(res, 200, {
      ok: true,
      config: publicConfig(next),
      resolved: { baseUrl: baseUrl(next), outputDir: outputDir(next), sizes: sizesFor(next) },
    })
  }, auth)
}

function keysRoute(auth) {
  // Keys live at their own endpoint so an add or remove never races a whole-config write.
  return guarded(async (req, res) => {
    const config = readConfig()
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, keys: publicConfig(config).apiKeys })
      return
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req)
      const action = body.action ?? 'add'
      if (action === 'add') {
        const key = typeof body.key === 'string' ? body.key.trim() : ''
        if (key.length < 8) return sendJson(res, 400, { ok: false, error: 'a key of at least 8 characters is required' })
        if (config.apiKeys.some((entry) => entry.key === key)) return sendJson(res, 409, { ok: false, error: 'that key is already configured' })
        const id = `key-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
        const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : `Key ${config.apiKeys.length + 1}`
        writeConfig({ apiKeys: [...config.apiKeys, { id, label, enabled: true, weight: 1, key }] })
        sendJson(res, 200, { ok: true, keys: publicConfig(readConfig()).apiKeys, added: maskKey(key) })
        return
      }
      if (action === 'addMany') {
        const raw = Array.isArray(body.keys) ? body.keys : String(body.keys ?? '').split(/[\s,]+/)
        const existing = new Set(config.apiKeys.map((entry) => entry.key))
        const added = []
        for (const candidate of raw) {
          const key = typeof candidate === 'string' ? candidate.trim() : ''
          if (key.length < 8 || existing.has(key)) continue
          existing.add(key)
          added.push({
            id: `key-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`,
            label: `Key ${config.apiKeys.length + added.length + 1}`,
            enabled: true,
            weight: 1,
            key,
          })
        }
        writeConfig({ apiKeys: [...config.apiKeys, ...added] })
        sendJson(res, 200, { ok: true, keys: publicConfig(readConfig()).apiKeys, addedCount: added.length })
        return
      }
      if (action === 'remove') {
        const id = typeof body.id === 'string' ? body.id : ''
        writeConfig({ apiKeys: config.apiKeys.filter((entry) => entry.id !== id) })
        sendJson(res, 200, { ok: true, keys: publicConfig(readConfig()).apiKeys })
        return
      }
      if (action === 'toggle') {
        const id = typeof body.id === 'string' ? body.id : ''
        // No explicit `enabled` means "flip it": a bare toggle call must not force keys on.
        const current = config.apiKeys.find((entry) => entry.id === id)
        if (current === undefined) return sendJson(res, 404, { ok: false, error: `no such key: ${id}` })
        const enabled = typeof body.enabled === 'boolean' ? body.enabled : !current.enabled
        writeConfig({ apiKeys: config.apiKeys.map((entry) => (entry.id === id ? { ...entry, enabled } : entry)) })
        sendJson(res, 200, { ok: true, keys: publicConfig(readConfig()).apiKeys })
        return
      }
      if (action === 'label') {
        const id = typeof body.id === 'string' ? body.id : ''
        const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : ''
        if (label.length === 0) return sendJson(res, 400, { ok: false, error: 'a label is required' })
        writeConfig({ apiKeys: config.apiKeys.map((entry) => (entry.id === id ? { ...entry, label } : entry)) })
        sendJson(res, 200, { ok: true, keys: publicConfig(readConfig()).apiKeys })
        return
      }
      if (action === 'clear') {
        writeConfig({ apiKeys: [] })
        sendJson(res, 200, { ok: true, keys: [] })
        return
      }
      return sendJson(res, 400, { ok: false, error: `unknown action ${action}` })
    }
    if (req.method === 'DELETE') {
      writeConfig({ apiKeys: [] })
      sendJson(res, 200, { ok: true, keys: [] })
      return
    }
    sendJson(res, 405, { ok: false, error: 'GET, POST or DELETE only' })
  }, auth)
}

function testRoute(auth) {
  return guarded(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
    const body = await readJsonBody(req)
    const config = readConfig()
    const keys = activeKeys(config)
    if (keys.length === 0) return sendJson(res, 200, { ok: false, error: 'No API key configured yet.' })
    const wanted = typeof body.id === 'string' ? keys.filter((entry) => entry.id === body.id) : keys
    const targets = wanted.length > 0 ? wanted : keys
    const results = []
    for (const entry of targets) {
      const startedAt = Date.now()
      try {
        const response = await fetch(`${baseUrl(config)}${config.upstream?.modelsPath ?? '/models'}`, {
          headers: { accept: 'application/json', authorization: `Bearer ${entry.key}` },
          signal: AbortSignal.timeout(20000),
        })
        const ms = Date.now() - startedAt
        if (response.ok) {
          const payload = await response.json().catch(() => ({}))
          const count = Array.isArray(payload?.data) ? payload.data.length : Array.isArray(payload?.models) ? payload.models.length : 0
          results.push({ id: entry.id, label: entry.label, ok: true, status: response.status, ms, models: count })
        } else {
          const text = await response.text().catch(() => '')
          results.push({ id: entry.id, label: entry.label, ok: false, status: response.status, ms, error: text.slice(0, 300) || `HTTP ${response.status}` })
        }
      } catch (error) {
        results.push({ id: entry.id, label: entry.label, ok: false, status: 0, ms: Date.now() - startedAt, error: error?.message ?? String(error) })
      }
    }
    sendJson(res, 200, { ok: results.every((row) => row.ok), results, baseUrl: baseUrl(config) })
  }, auth)
}

function modelsRoute(auth) {
  return guarded(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET or POST only' })
    const config = readConfig()
    try {
      const models = await listModels({ config })
      const imageModels = models.filter((row) => Array.isArray(row.outputModalities) && row.outputModalities.includes('image'))
      const visionModels = models.filter((row) => Array.isArray(row.inputModalities) && row.inputModalities.includes('image'))
      sendJson(res, 200, {
        ok: true,
        models,
        imageModels,
        visionModels,
        sizes: sizesFor(config),
        baseUrl: baseUrl(config),
      })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error.message, code: error.code, status: error.status, baseUrl: baseUrl(config) })
    }
  }, auth)
}

// --- workspace ---------------------------------------------------------------------------------

function workspaceRoute(auth) {
  return guarded(async (req, res) => {
    const config = readConfig()
    if (req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        workspace: publicWorkspace(getWorkspace()),
        sizes: sizesFor(config),
        models: config.models,
      })
      return
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET or POST only' })
    const body = await readJsonBody(req, 32 * 1024 * 1024)
    const action = body.action ?? 'update'
    const workspace = getWorkspace()
    if (action === 'update') {
      const patch = body.patch ?? body
      const clean = {}
      if (typeof patch.stylePrompt === 'string') clean.stylePrompt = patch.stylePrompt
      if (patch.models && typeof patch.models === 'object') {
        clean.models = {
          image: typeof patch.models.image === 'string' ? patch.models.image : workspace.models?.image ?? '',
          vision: typeof patch.models.vision === 'string' ? patch.models.vision : workspace.models?.vision ?? '',
        }
      }
      if (typeof patch.currentVersionId === 'string') clean.currentVersionId = patch.currentVersionId
      updateRecord(workspace.id, clean)
      sendJson(res, 200, { ok: true, workspace: publicWorkspace(getWorkspace()) })
      return
    }
    if (action === 'deleteVersion') {
      deleteVersion(workspace.id, String(body.versionId ?? ''))
      sendJson(res, 200, { ok: true, workspace: publicWorkspace(getWorkspace()) })
      return
    }
    if (action === 'patchVersion') {
      patchVersion(workspace.id, String(body.versionId ?? ''), body.patch ?? {})
      sendJson(res, 200, { ok: true, workspace: publicWorkspace(getWorkspace()) })
      return
    }
    if (action === 'clearConversation') {
      clearConversation(workspace.id)
      sendJson(res, 200, { ok: true, workspace: publicWorkspace(getWorkspace()) })
      return
    }
    if (action === 'message') {
      appendMessage(workspace.id, { role: 'user', kind: 'note', text: String(body.text ?? '') })
      sendJson(res, 200, { ok: true, workspace: publicWorkspace(getWorkspace()) })
      return
    }
    if (action === 'reset') {
      resetWorkspace()
      sendJson(res, 200, { ok: true, workspace: publicWorkspace(getWorkspace()) })
      return
    }
    if (action === 'gc') {
      sendJson(res, 200, { ok: true, ...collectGarbage(), workspace: publicWorkspace(getWorkspace()) })
      return
    }
    sendJson(res, 400, { ok: false, error: `unknown action ${action}` })
  }, auth)
}

// --- operations --------------------------------------------------------------------------------

function operationsRoute(auth) {
  return guarded(async (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        operations: operationCatalog(),
        presets: {
          element: ELEMENT_PRESET_LIST,
          asset: ASSET_KIND_LIST,
          colour: COLOUR_MODE_LIST,
          fusion: FUSION_MODE_LIST,
        },
      })
      return
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET or POST only' })
    const body = await readJsonBody(req, 64 * 1024 * 1024)
    const op = String(body.op ?? 'text2image')
    const result = await execute(op, body, {
      baseVersionId: body.baseVersionId,
      config: readConfig(),
    })
    sendJson(res, 200, result)
  }, auth)
}

function previewRoute(auth) {
  // A dry run: expand variables or count a prompt list without spending a request.
  return guarded(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
    const body = await readJsonBody(req, 4 * 1024 * 1024)
    const config = readConfig()
    if (body.op === 'batchVariables') {
      const expanded = expandVariables(String(body.prompt ?? ''), body.values ?? {}, config.limits?.maxBatch ?? 50)
      sendJson(res, 200, {
        ok: true,
        names: expanded.names,
        count: expanded.prompts.length,
        prompts: expanded.prompts,
        truncated: expanded.truncated,
      })
      return
    }
    if (body.op === 'batchList') {
      const lines = (Array.isArray(body.prompts) ? body.prompts : String(body.prompts ?? '').split(/\r?\n/))
        .map((row) => String(row ?? '').trim())
        .filter((row) => row.length > 0)
      sendJson(res, 200, { ok: true, count: lines.length, prompts: lines.slice(0, 200) })
      return
    }
    sendJson(res, 400, { ok: false, error: 'nothing to preview for that operation' })
  }, auth)
}

function recogniseRoute(auth) {
  return guarded(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
    const body = await readJsonBody(req, 32 * 1024 * 1024)
    const config = readConfig()
    const workspace = getWorkspace()
    let source = typeof body.image === 'string' && body.image.length > 0 ? decodeUpload(body.image, config) : null
    if (source === null) {
      const version = getVersion(workspace.id, body.versionId ?? workspace.currentVersionId)
      const assetId = version.images?.[0]
      if (assetId) source = { buffer: readAsset(assetId), mediaType: 'image/png' }
    }
    if (source === null) return sendJson(res, 400, { ok: false, error: 'there is no picture to read yet' })
    const result = await recogniseText({ source, visionModel: body.visionModel }, {
      config,
      model: config.models?.default,
      visionModel: body.visionModel ?? workspace.models?.vision ?? config.models?.visionDefault,
    })
    sendJson(res, 200, { ok: true, ...result })
  }, auth)
}

// --- assets ------------------------------------------------------------------------------------

function assetRoute(auth) {
  return guarded(async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
    const bytes = readAsset(searchOf(req).get('id') ?? '')
    const info = await probe(bytes).catch(() => null)
    const mediaType = info?.format === 'jpeg' ? 'image/jpeg' : info?.format === 'webp' ? 'image/webp' : 'image/png'
    sendBinary(res, 200, mediaType, bytes)
  }, auth)
}

function versionZipRoute(auth) {
  return guarded(async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
    const params = searchOf(req)
    const workspace = getWorkspace()
    const version = getVersion(workspace.id, params.get('versionId') ?? workspace.currentVersionId)
    const entries = []
    for (let index = 0; index < (version.images ?? []).length; index += 1) {
      entries.push({ name: `pixelfly-${version.id}-${index + 1}.png`, data: readAsset(version.images[index]) })
    }
    if (entries.length === 0) return sendJson(res, 404, { ok: false, error: 'that version has no images' })
    const zip = createZip(entries)
    sendBinary(res, 200, 'application/zip', zip, {
      disposition: `attachment; filename="pixelfly-${version.id}.zip"`,
      cacheControl: 'no-store',
    })
  }, auth)
}

// --- prompt library ----------------------------------------------------------------------------

function libraryRoute(auth) {
  return guarded(async (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, ...readLibrary() })
      return
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET or POST only' })
    const body = await readJsonBody(req)
    const action = body.action ?? 'add'
    if (action === 'add') {
      sendJson(res, 200, { ok: true, prompt: addLibraryPrompt({ title: body.title, text: body.text }) })
      return
    }
    if (action === 'remove') {
      sendJson(res, 200, removeLibraryPrompt(String(body.id ?? '')))
      return
    }
    sendJson(res, 400, { ok: false, error: `unknown action ${action}` })
  }, auth)
}

function statsRoute(auth) {
  return guarded(async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
    const config = readConfig()
    const state = readState()
    const keys = activeKeys(config)
    const pool = new KeyPool(keys, {
      rotate: config.retry?.rotateKeys !== false,
      cooldownMs: config.retry?.cooldownMs ?? 60000,
    })
    sendJson(res, 200, {
      ok: true,
      baseUrl: baseUrl(config),
      outputDir: outputDir(config),
      keyCount: keys.length,
      retry: config.retry,
      models: config.models,
      sizes: sizesFor(config),
      lastRun: state.lastRun ?? null,
      versionCount: getWorkspace().versions.length,
      pool: pool.snapshot(),
    })
  }, auth)
}

// --- plugin ------------------------------------------------------------------------------------

export function apply(ctx, config) {
  const disposers = []
  for (const definition of createTools(ctx)) {
    disposers.push(ctx.tools.register(definition))
  }

  const auth = createHttpAuth(ctx, makePolicy(config))
  const routes = [
    [TOKEN_ROUTE, tokenRoute(auth)],
    [`${ROUTE_BASE}/config`, configRoute(auth)],
    [`${ROUTE_BASE}/keys`, keysRoute(auth)],
    [`${ROUTE_BASE}/test`, testRoute(auth)],
    [`${ROUTE_BASE}/models`, modelsRoute(auth)],
    [`${ROUTE_BASE}/workspace`, workspaceRoute(auth)],
    [`${ROUTE_BASE}/operations`, operationsRoute(auth)],
    [`${ROUTE_BASE}/preview`, previewRoute(auth)],
    [`${ROUTE_BASE}/recognise`, recogniseRoute(auth)],
    [`${ROUTE_BASE}/asset`, assetRoute(auth)],
    [`${ROUTE_BASE}/version.zip`, versionZipRoute(auth)],
    [`${ROUTE_BASE}/library`, libraryRoute(auth)],
    [`${ROUTE_BASE}/stats`, statsRoute(auth)],
  ]

  ctx.inject(['webServer'], (webCtx) => {
    for (const [routePath, handler] of routes) {
      webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: routePath, handler }), `pixelfly:${routePath}`)
    }
  })

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* already gone */ }
    }
  }, 'pixelfly:tools')
}
