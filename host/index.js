// dsh-pixelfly — Host half.
//
// Registers the three model-facing tools, plus the HTTP routes the settings page and
// the studio page talk to. Named Web routes carry no server-wide auth, so every route
// below sits behind a Host/Origin fence, DSH's own connection admission for browser
// requests, and a per-process Bearer token the page bootstraps from a token route.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { activeKeys, baseUrl, imagesRoot, maskKey, outputDir, pluginRoot, publicConfig, readConfig, readState, writeConfig } from './config.js'
import { createTools } from './tools.js'
import { generateImages } from './generate.js'
import { KeyPool, listModels, UpstreamError } from './upstream.js'
import { listGenerated, readGeneratedFile } from './images.js'

export const inject = ['tools']

const ROUTE_BASE = '/pixelfly/api'
const TOKEN_ROUTE = `${ROUTE_BASE}/token`
const CONFIG_ROUTE = `${ROUTE_BASE}/config`
const TEST_ROUTE = `${ROUTE_BASE}/test`
const MODELS_ROUTE = `${ROUTE_BASE}/models`
const GENERATE_ROUTE = `${ROUTE_BASE}/generate`
const GALLERY_ROUTE = `${ROUTE_BASE}/gallery`
const FILE_ROUTE = `${ROUTE_BASE}/file`
const STATS_ROUTE = `${ROUTE_BASE}/stats`

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

// The fence is loopback-only by default. A Harness deliberately served on a LAN address
// (or behind a tunnel) must widen it explicitly, exactly as the Web UI's own trusted-host
// list does: `allowNonLoopback: true` plus the `trustedHosts` entries it will be reached by.
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
  // Same-origin is always fine; a cross-origin caller must at least still be a host the
  // fence admits, which keeps a page on a trusted host from being a stepping stone.
  if (parsed.host.toLowerCase() === authority.host.toLowerCase()) return true
  if (isLoopbackHostname(parsed.hostname)) return policy.allowNonLoopback === false ? false : true
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

async function rejectRequest(req, auth, options = {}) {
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
    const rejection = await rejectRequest(req, auth, options)
    if (rejection !== undefined) {
      sendJson(res, rejection, {
        ok: false,
        error: rejection === 401 ? 'unauthorized' : 'forbidden',
        hint: rejection === 401 && options.requireToken !== false ? 'send Authorization: Bearer <token> from GET /pixelfly/api/token' : undefined,
      })
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, error instanceof UpstreamError && error.status >= 400 ? error.status : 500, {
          ok: false,
          error: error?.message ?? String(error),
          code: error?.code,
          status: error?.status,
        })
      } else {
        try { res.end() } catch { /* already gone */ }
      }
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

// --- routes ------------------------------------------------------------------------------------

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
          keyCount: activeKeys(config).length,
        },
        stats: state.lastRun ?? null,
        history: Array.isArray(state.history) ? state.history.slice(0, 10) : [],
      })
      return
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET or POST only' })
    const body = await readJsonBody(req)
    const patch = {}
    if (body.upstream && typeof body.upstream === 'object') {
      const upstream = {}
      if (typeof body.upstream.baseUrl === 'string') {
        if (!/^https?:\/\//i.test(body.upstream.baseUrl.trim())) return sendJson(res, 400, { ok: false, error: 'baseUrl must be an http(s) URL' })
        upstream.baseUrl = body.upstream.baseUrl.trim()
      }
      if (Number.isFinite(Number(body.upstream.timeoutMs))) upstream.timeoutMs = Math.max(5000, Math.min(600000, Math.round(Number(body.upstream.timeoutMs))))
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
    const next = writeConfig(patch)
    sendJson(res, 200, { ok: true, config: publicConfig(next), resolved: { baseUrl: baseUrl(next), outputDir: outputDir(next) } })
  }, auth)
}

function keysRoute(auth) {
  // Keys live at their own endpoint so an add/remove never races a whole-config write.
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
        const next = [...config.apiKeys, { id, label: typeof body.label === 'string' && body.label.trim() ? body.label.trim() : `Key ${config.apiKeys.length + 1}`, enabled: true, weight: 1, key }]
        writeConfig({ apiKeys: next })
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
          added.push({ id: `key-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`, label: `Key ${config.apiKeys.length + added.length + 1}`, enabled: true, weight: 1, key })
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

function modelsRoute(auth) {
  return guarded(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET or POST only' })
    const config = readConfig()
    try {
      const models = await listModels({ config })
      sendJson(res, 200, { ok: true, models, baseUrl: baseUrl(config) })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error.message, code: error.code, status: error.status, baseUrl: baseUrl(config) })
    }
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

function generateRoute(auth) {
  return guarded(async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
    const body = await readJsonBody(req, 8 * 1024 * 1024)
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (prompt.length === 0) return sendJson(res, 400, { ok: false, error: 'prompt is required' })
    const result = await generateImages(
      { prompt, model: body.model, size: body.size, n: body.n, watermark: body.watermark, promptExtend: body.promptExtend, images: body.images },
      {},
    )
    sendJson(res, 200, {
      ok: true,
      model: result.model,
      prompt: result.prompt,
      size: result.size,
      n: result.n,
      attempts: result.attempts,
      keyId: result.keyId,
      elapsedMs: result.elapsedMs,
      trace: result.trace,
      usage: result.usage,
      images: result.images.map(({ data: _data, ...rest }) => rest),
    })
  }, auth)
}

function galleryRoute(auth) {
  return guarded(async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const limit = Math.max(1, Math.min(120, Number(url.searchParams.get('limit') ?? 24) || 24))
    sendJson(res, 200, { ok: true, dir: outputDir(readConfig()), files: listGenerated(limit) })
  }, auth)
}

function fileRoute(auth) {
  return guarded(async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const requested = url.searchParams.get('path') ?? ''
    const file = readGeneratedFile(requested)
    if (file === null) return sendJson(res, 404, { ok: false, error: 'no such generated file' })
    res.statusCode = 200
    res.setHeader('content-type', file.sniff?.mediaType ?? 'application/octet-stream')
    res.setHeader('content-length', String(file.bytes.length))
    res.setHeader('cache-control', 'private, max-age=60')
    res.setHeader('x-content-type-options', 'nosniff')
    res.end(file.bytes)
  }, auth)
}

function statsRoute(auth) {
  return guarded(async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
    const config = readConfig()
    const state = readState()
    sendJson(res, 200, {
      ok: true,
      baseUrl: baseUrl(config),
      outputDir: outputDir(config),
      keyCount: activeKeys(config).length,
      retry: config.retry,
      models: config.models,
      lastRun: state.lastRun ?? null,
      history: Array.isArray(state.history) ? state.history.slice(0, 20) : [],
      files: listGenerated(8),
      pool: new KeyPool(activeKeys(config), { rotate: config.retry?.rotateKeys !== false, cooldownMs: config.retry?.cooldownMs }).snapshot(),
    })
  }, auth)
}

// --- plugin ------------------------------------------------------------------------------------

export function apply(ctx, config) {
  const disposers = []
  const tools = createTools(ctx)
  for (const definition of tools) {
    disposers.push(ctx.tools.register(definition))
  }

  const auth = createHttpAuth(ctx, makePolicy(config))
  const routes = [
    [TOKEN_ROUTE, tokenRoute(auth)],
    [CONFIG_ROUTE, configRoute(auth)],
    [`${ROUTE_BASE}/keys`, keysRoute(auth)],
    [TEST_ROUTE, testRoute(auth)],
    [MODELS_ROUTE, modelsRoute(auth)],
    [GENERATE_ROUTE, generateRoute(auth)],
    [GALLERY_ROUTE, galleryRoute(auth)],
    [FILE_ROUTE, fileRoute(auth)],
    [STATS_ROUTE, statsRoute(auth)],
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
