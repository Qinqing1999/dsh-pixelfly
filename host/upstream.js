// dsh-pixelfly — upstream client.
//
// One job: take a JSON request, try it against the configured upstream with every
// usable API key in rotation, and back off between attempts. Nothing here knows
// about DSH; the Host half, the HTTP routes and the vision layer all call in.
//
// The rotation rule is worth stating because it is easy to get wrong: a key that
// answers 401/402/403 is not evidence that the *request* is bad, only that this
// key is. So a rejected key is swapped for the next one without sleeping — there
// is nothing to wait for — and the attempt budget is widened to cover at least one
// pass over the ring. A 429 or a 5xx, by contrast, means "ask again later", which
// is where the exponential backoff applies.

import { activeKeys, baseUrl, readConfig } from './config.js'

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
])

/** Error carrying the HTTP status and the upstream's own message. */
export class UpstreamError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.status = options.status ?? 0
    this.code = options.code ?? 'upstream_error'
    this.retryable = options.retryable === true
    this.retryAfterMs = options.retryAfterMs ?? null
    this.keyId = options.keyId
    this.body = options.body
    this.attempts = options.attempts ?? 1
    this.trace = options.trace
  }
}

/**
 * A key pool with a rotation cursor and per-key cooldowns.
 *
 * Cooldowns matter because upstreams rate-limit per key: a key that just answered
 * 429 must not be the first thing the next attempt reaches for.
 */
export class KeyPool {
  constructor(entries, options = {}) {
    this.entries = entries.map((entry) => ({ ...entry }))
    this.cursor = 0
    this.cooldowns = new Map()
    this.rotate = options.rotate !== false
    this.cooldownMs = options.cooldownMs ?? 60000
    this.attempts = new Map()
    this.successes = new Map()
  }

  get size() {
    return this.entries.length
  }

  /** True when at least one key is outside its cooldown window. */
  hasUsable(now = Date.now()) {
    return this.entries.some((entry) => (this.cooldowns.get(entry.id) ?? 0) <= now)
  }

  /** Round-robin over the entries, skipping keys that are cooling down. */
  next(now = Date.now()) {
    if (this.entries.length === 0) return undefined
    const order = []
    for (let step = 0; step < this.entries.length; step += 1) {
      order.push(this.entries[(this.cursor + step) % this.entries.length])
    }
    const usable = order.filter((entry) => (this.cooldowns.get(entry.id) ?? 0) <= now)
    const chosen = usable[0] ?? order[0]
    this.cursor = (this.entries.indexOf(chosen) + 1) % this.entries.length
    return chosen
  }

  markSuccess(entry) {
    if (!entry) return
    this.cooldowns.delete(entry.id)
    this.successes.set(entry.id, (this.successes.get(entry.id) ?? 0) + 1)
  }

  markFailure(entry, error, now = Date.now()) {
    if (!entry) return
    const status = error?.status ?? 0
    const cooling = status === 429 || status === 401 || status === 403 || status === 402
    if (!cooling) return
    const explicit = Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0 ? error.retryAfterMs : this.cooldownMs
    this.cooldowns.set(entry.id, now + Math.max(1000, Math.min(explicit, 30 * 60000)))
  }

  snapshot(now = Date.now()) {
    return this.entries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      cooling: (this.cooldowns.get(entry.id) ?? 0) > now,
      cooldownUntil: this.cooldowns.get(entry.id) ?? 0,
      attempts: this.attempts.get(entry.id) ?? 0,
      successes: this.successes.get(entry.id) ?? 0,
    }))
  }
}

function parseRetryAfter(headers) {
  const raw = headers?.get?.('retry-after')
  if (typeof raw !== 'string' || raw.length === 0) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(raw)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return null
}

/** Exponential backoff with a jitter band, capped at the configured ceiling. */
export function backoffDelay(attempt, retry = {}, retryAfterMs = null) {
  if (retry.respectRetryAfter !== false && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(Math.max(0, retryAfterMs), retry.maxDelayMs ?? 20000)
  }
  const base = Math.max(1, retry.baseDelayMs ?? 700)
  const cap = Math.max(base, retry.maxDelayMs ?? 20000)
  const raw = Math.min(cap, base * 2 ** Math.max(0, attempt - 1))
  const jitter = Math.max(0, Math.min(1, retry.jitter ?? 0.25))
  if (jitter === 0) return raw
  const spread = raw * jitter
  return Math.round(raw - spread / 2 + Math.random() * spread)
}

function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new UpstreamError('cancelled', { code: 'aborted' }))
    }
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        reject(new UpstreamError('cancelled', { code: 'aborted' }))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * Turn an upstream's terse English string into something a user can act on.
 *
 * The raw text is kept on the error body, so nothing is lost for debugging; this
 * only decides what to show.
 */
export function friendlyMessage(raw, status) {
  const text = typeof raw === 'string' ? raw : ''
  if (/sensitive|content.?review|inappropriate|blocked/i.test(text)) return 'The upstream content filter rejected this request. Change the image or prompt and try again.'
  if (/image should be|image.*not.*support|invalid.*image/i.test(text)) return `The upstream rejected the input image. Upstream said: ${text.slice(0, 300)}`
  if (/rps|rate.?limit|too many requests|tpm|rpm/i.test(text) || status === 429) return 'The upstream rate limit was reached. PixelFly backed off; try again shortly.'
  if (/quota|insufficient|balance|arrears/i.test(text) || status === 402) return 'The upstream account is out of quota or unpaid.'
  if (/unauthorized|invalid.*(api.?key|token)|authentication/i.test(text) || status === 401) return 'The upstream rejected the API key.'
  if (status === 404) return 'The upstream has no such endpoint or model. Check the base URL and model id.'
  if (status >= 500) return `The upstream failed (HTTP ${status}). It was retried.`
  return text.length > 0 ? text : `The upstream answered HTTP ${status || 'error'}.`
}

/** Read an error body without assuming JSON. */
async function readErrorBody(response) {
  try {
    const text = await response.text()
    if (text.length === 0) return { raw: '', message: '' }
    try {
      const parsed = JSON.parse(text)
      const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error ?? text
      return { raw: text, message: typeof message === 'string' ? message : JSON.stringify(message), json: parsed }
    } catch {
      return { raw: text, message: text }
    }
  } catch {
    return { raw: '', message: '' }
  }
}

/** One HTTP attempt with one key; maps transport and HTTP failures onto UpstreamError. */
async function postOnce(url, body, apiKey, options) {
  const { timeoutMs, signal } = options
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) throw new UpstreamError('cancelled', { code: 'aborted' })
    signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs))
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(options.extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    if (signal?.aborted) throw new UpstreamError('cancelled', { code: 'aborted' })
    const code = error?.cause?.code ?? error?.code ?? ''
    const timedOut = error?.name === 'AbortError'
    throw new UpstreamError(
      timedOut
        ? `The upstream did not answer within ${Math.round(timeoutMs / 1000)}s.`
        : `Network error contacting the upstream${code ? ` (${code})` : ''}.`,
      {
        code: timedOut ? 'timeout' : 'network',
        retryable: timedOut || RETRYABLE_NETWORK_CODES.has(code) || code === '',
        status: 0,
      },
    )
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }

  if (!response.ok) {
    const detail = await readErrorBody(response)
    const retryable = (options.retryOn || []).includes(response.status) || response.status >= 500
    throw new UpstreamError(friendlyMessage(detail.message, response.status), {
      status: response.status,
      code: response.status === 429 ? 'rate_limited' : response.status === 401 ? 'unauthorized' : 'http_error',
      retryable,
      retryAfterMs: parseRetryAfter(response.headers),
      body: detail.raw.slice(0, 2000),
    })
  }

  try {
    return await response.json()
  } catch {
    throw new UpstreamError('The upstream returned a body that is not JSON.', { status: response.status, code: 'bad_body', retryable: true })
  }
}

/**
 * POST a JSON body with key rotation and backoff.
 *
 * @param url - absolute upstream URL.
 * @param body - JSON body.
 * @param options - `{ config, signal, onAttempt, pool, label }`.
 * @returns `{ payload, attempt, keyId, trace, pool }`.
 */
export async function postJson(url, body, options = {}) {
  const config = options.config ?? readConfig()
  const retry = config.retry ?? {}
  const keys = activeKeys(config)
  if (keys.length === 0) {
    throw new UpstreamError('No API key is configured. Add one on the PixelFly settings page.', { code: 'no_key' })
  }
  const pool = options.pool ?? new KeyPool(keys, { rotate: retry.rotateKeys !== false, cooldownMs: retry.cooldownMs ?? 60000 })
  const configured = Math.max(1, Math.min(12, Math.round(retry.maxAttempts ?? 4)))
  const rotateBudget = retry.rotateKeys === false ? 1 : Math.min(pool.size, 8)
  const maxAttempts = Math.max(configured, rotateBudget)
  const retryOn = Array.isArray(retry.retryOn) && retry.retryOn.length > 0 ? retry.retryOn : [408, 425, 429, 500, 502, 503, 504]
  const trace = []
  let lastError = null
  let backoffs = 0

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw new UpstreamError('cancelled', { code: 'aborted' })
    const entry = pool.next()
    if (!entry) throw new UpstreamError('No API key is configured.', { code: 'no_key' })
    pool.attempts.set(entry.id, (pool.attempts.get(entry.id) ?? 0) + 1)
    const startedAt = Date.now()
    try {
      const payload = await postOnce(url, body, entry.key, {
        timeoutMs: options.timeoutMs ?? config.upstream?.timeoutMs ?? 180000,
        signal: options.signal,
        retryOn,
        extraHeaders: options.extraHeaders,
      })
      pool.markSuccess(entry)
      const row = { attempt, keyId: entry.id, status: 200, ms: Date.now() - startedAt }
      trace.push(row)
      options.onAttempt?.({ ...row, trace })
      return { payload, attempt, keyId: entry.id, trace, pool }
    } catch (error) {
      const failure = error instanceof UpstreamError
        ? error
        : new UpstreamError(String(error?.message ?? error), { code: 'unknown', retryable: false })
      lastError = failure
      pool.markFailure(entry, failure)
      const row = {
        attempt,
        keyId: entry.id,
        status: failure.status,
        code: failure.code,
        ms: Date.now() - startedAt,
        message: failure.message,
      }
      trace.push(row)
      options.onAttempt?.({ ...row, trace })
      if (failure.code === 'aborted') throw failure
      const keyScoped = failure.status === 401 || failure.status === 402 || failure.status === 403
      // The failed key is already cooling, so `hasUsable()` now means "another key may work".
      const canRotate = keyScoped && pool.size > 1 && pool.hasUsable()
      const canBackoff = failure.retryable && attempt < maxAttempts
      if (!canRotate && !canBackoff) {
        failure.attempts = attempt
        failure.trace = trace
        throw failure
      }
      if (!canRotate) {
        backoffs += 1
        await sleep(backoffDelay(backoffs, retry, failure.retryAfterMs), options.signal)
      }
    }
  }

  const final = lastError ?? new UpstreamError('The upstream failed.', { code: 'unknown' })
  final.attempts = maxAttempts
  final.trace = trace
  throw final
}

/** POST a body to a path under the configured base URL. */
export async function callUpstream(pathname, body, options = {}) {
  const config = options.config ?? readConfig()
  return postJson(`${baseUrl(config)}${pathname}`, body, { ...options, config })
}

/** List the upstream's models with one key, for the settings page probe. */
export async function listModels(options = {}) {
  const config = options.config ?? readConfig()
  const keys = activeKeys(config)
  if (keys.length === 0) throw new UpstreamError('No API key is configured.', { code: 'no_key' })
  const entry = keys[0]
  const url = `${baseUrl(config)}${config.upstream?.modelsPath ?? '/models'}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', authorization: `Bearer ${entry.key}` }, signal: controller.signal })
    if (!response.ok) {
      const detail = await readErrorBody(response)
      throw new UpstreamError(friendlyMessage(detail.message, response.status), { status: response.status, code: 'http_error' })
    }
    const payload = await response.json()
    const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
    return rows.map((row) => ({
      id: row?.id ?? row?.model ?? '',
      label: row?.name ?? row?.id ?? row?.model ?? '',
      inputModalities: row?.input_modalities ?? row?.inputModalities ?? [],
      outputModalities: row?.output_modalities ?? row?.outputModalities ?? [],
      description: typeof row?.description === 'string' ? row.description.slice(0, 400) : '',
    })).filter((row) => row.id.length > 0)
  } finally {
    clearTimeout(timer)
  }
}
