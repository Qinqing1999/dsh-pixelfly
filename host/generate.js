// dsh-pixelfly — the generation service.
//
// One function does the whole job: build the upstream body from the request plus the
// stored defaults, call the upstream through the key pool and backoff loop, decode the
// images, write them to disk, and return a result both the tool and the HTTP route can
// render. Keeping this in one place is what makes the tool and the studio page behave
// identically.

import { readConfig, writeState, readState } from './config.js'
import { callUpstream, UpstreamError } from './upstream.js'
import { downloadImage, imagesFromPayload, pruneOutput, saveImageBytes, sniffImage } from './images.js'

export const DEFAULT_MODEL = 'sensenova-u1.5-fast'
export const KNOWN_MODELS = ['sensenova-u1.5-fast', 'sensenova-u1.5-lite']

function normalizeSize(size, config) {
  const value = typeof size === 'string' && size.trim().length > 0 ? size.trim() : String(config.request?.size ?? '1024x1024')
  if (value.toLowerCase() === 'auto') return 'auto'
  return /^\d{2,5}x\d{2,5}$/.test(value) ? value : String(config.request?.size ?? '1024x1024')
}

function buildBody(args, config) {
  const body = {
    model: args.model,
    prompt: args.prompt,
    n: Math.max(1, Math.min(4, Math.round(Number(args.n ?? config.request?.n ?? 1)))),
    size: normalizeSize(args.size, config),
    response_format: config.request?.responseFormat ?? 'b64_json',
    output_format: config.request?.outputFormat ?? 'png',
    watermark: args.watermark ?? config.request?.watermark === true,
    prompt_extend: args.promptExtend ?? config.request?.promptExtend !== false,
  }
  if (Array.isArray(args.images) && args.images.length > 0) {
    body.size = normalizeSize(args.size, config) === 'auto' ? 'auto' : body.size
    body.images = args.images
  }
  return body
}

function recordHistory(entry) {
  try {
    const state = readState()
    const history = Array.isArray(state.history) ? state.history : []
    history.unshift(entry)
    state.history = history.slice(0, 60)
    state.lastRun = { at: entry.at, model: entry.model, ok: entry.ok, attempts: entry.attempts }
    writeState(state)
  } catch { /* history is advisory */ }
}

/**
 * Generate images.
 *
 * @param args - `{ prompt, model?, size?, n?, images?, watermark?, promptExtend? }`.
 * @param options - `{ signal?, onAttempt?, config? }`.
 * @returns `{ ok, model, prompt, size, images, attempts, trace, usage, elapsedMs, keyId }`.
 */
export async function generateImages(args, options = {}) {
  const config = options.config ?? readConfig()
  const prompt = String(args?.prompt ?? '').trim()
  if (prompt.length === 0) throw new UpstreamError('A prompt is required.', { code: 'bad_request' })
  const model = String(args?.model ?? config.models?.default ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL
  const body = buildBody({ ...args, prompt, model }, config)
  const startedAt = Date.now()

  let result
  try {
    result = await callUpstream(config.upstream?.imagesPath ?? '/images/generations', body, {
      config,
      signal: options.signal,
      onAttempt: options.onAttempt,
    })
  } catch (error) {
    recordHistory({ at: new Date().toISOString(), ok: false, model, prompt: prompt.slice(0, 200), error: error.message, attempts: error.attempts ?? 0 })
    throw error
  }

  const candidates = imagesFromPayload(result.payload)
  if (candidates.length === 0) {
    const message = 'The upstream answered without any image data.'
    recordHistory({ at: new Date().toISOString(), ok: false, model, prompt: prompt.slice(0, 200), error: message, attempts: result.attempt })
    throw new UpstreamError(message, { code: 'empty_result', status: 200 })
  }

  const saved = []
  for (const candidate of candidates) {
    const bytes = candidate.bytes ?? (await downloadImage(candidate.url, options.signal))
    const sniff = sniffImage(bytes)
    if (sniff === null) continue
    if (config.output?.saveToDisk === false) {
      saved.push({ ...sniff, bytes: bytes.length, data: bytes, path: null })
      continue
    }
    const file = saveImageBytes(bytes, { config, prompt, format: sniff.format })
    saved.push({ ...file, data: bytes })
  }

  if (saved.length === 0) {
    throw new UpstreamError('The upstream returned bytes that are not a recognised image.', { code: 'bad_image', status: 200 })
  }

  if (config.output?.saveToDisk !== false) {
    try { pruneOutput(config) } catch { /* pruning is housekeeping */ }
  }

  const elapsedMs = Date.now() - startedAt
  recordHistory({
    at: new Date().toISOString(),
    ok: true,
    model,
    prompt: prompt.slice(0, 200),
    attempts: result.attempt,
    keyId: result.keyId,
    elapsedMs,
    files: saved.map((entry) => entry.path).filter(Boolean),
  })

  return {
    ok: true,
    model,
    prompt,
    size: body.size,
    n: saved.length,
    images: saved.map((entry) => ({
      path: entry.path ?? '',
      mediaType: entry.mediaType,
      format: entry.format,
      width: entry.width,
      height: entry.height,
      bytes: entry.bytes,
      data: entry.data,
    })),
    attempts: result.attempt,
    keyId: result.keyId,
    trace: result.trace,
    usage: result.payload?.usage ?? null,
    elapsedMs,
  }
}
