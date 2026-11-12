// dsh-pixelfly — image providers.
//
// One function, `renderImages`, that takes a prompt, zero or more input pictures
// and a target size, and returns decoded image bytes. Everything provider-specific
// lives here so the operations layer never thinks about wire formats.
//
// The important asymmetry: a provider that only returns one picture per request
// still has to satisfy "give me four variations", so this splits the request and
// merges the answers. Conversely an edit request is never batched — each input
// picture gets its own call.

import { baseUrl } from './config.js'
import { UpstreamError, callUpstream, postJson } from './upstream.js'
import { assertStill } from './raster.js'

// Per-provider wire behaviour. `onePerRequest` means one picture per call, so a
// request for four has to be split; `editSize` is what an edit call should ask
// for when the provider picks its own canvas.
const DEFAULTS = {
  sensenova: { supportsEdit: true, onePerRequest: true, editSize: 'auto' },
  openai: { supportsEdit: true, onePerRequest: false, editSize: null },
  gemini: { supportsEdit: true, onePerRequest: true, editSize: null },
  grok: { supportsEdit: true, onePerRequest: true, editSize: null },
}

/** The provider names the settings page offers. */
export const PROVIDERS = ['sensenova', 'openai', 'gemini', 'grok']

export function providerProfile(config) {
  const name = config.upstream?.provider ?? 'sensenova'
  return { name, ...(DEFAULTS[name] ?? DEFAULTS.openai) }
}

function parseSize(size) {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(String(size ?? '').trim())
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width < 256 || height < 256 || width > 4096 || height > 4096) return null
  return { width, height, text: `${width}x${height}` }
}

function dataUrl(image) {
  return `data:${image.mediaType ?? 'image/png'};base64,${Buffer.from(image.buffer).toString('base64')}`
}

function aspectOf(size) {
  const parsed = parseSize(size)
  if (parsed === null) return '1:1'
  const ratio = parsed.width / parsed.height
  const table = [
    ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['16:9', 16 / 9], ['9:16', 9 / 16],
    ['3:2', 3 / 2], ['2:3', 2 / 3], ['21:9', 21 / 9],
  ]
  let best = table[0]
  for (const row of table) {
    if (Math.abs(Math.log(ratio / row[1])) < Math.abs(Math.log(ratio / best[1]))) best = row
  }
  return best[0]
}

/** Build the JSON body for one upstream call. */
function buildBody({ provider, model, prompt, size, n, images, config }) {
  const request = config.request ?? {}
  const base = {
    model,
    prompt,
    n: provider.onePerRequest ? 1 : Math.max(1, Math.min(4, n)),
  }
  if (size) base.size = images.length > 0 && provider.editSize ? provider.editSize : size
  if (provider.name === 'gemini') {
    base.response_format = { type: 'image', mime_type: 'image/png', aspect_ratio: aspectOf(size) }
    if (images.length > 0) base.images = images.map((image) => ({ image_url: dataUrl(image) }))
    return base
  }
  if (provider.name === 'grok') {
    // Grok takes the OpenAI image shape but no prompt rewriting knobs.
    base.response_format = request.responseFormat ?? 'b64_json'
    if (images.length > 0) base.images = images.map((image) => ({ image_url: dataUrl(image) }))
    return base
  }
  base.response_format = request.responseFormat ?? 'b64_json'
  base.output_format = request.outputFormat ?? 'png'
  base.watermark = request.watermark === true
  base.prompt_extend = request.promptExtend !== false
  if (images.length > 0) base.images = images.map((image) => ({ image_url: dataUrl(image) }))
  return base
}

/** Pull the raw image entries out of a provider response. */
function entriesOf(payload) {
  const rows = []
  if (Array.isArray(payload?.data)) {
    for (const row of payload.data) {
      if (row && typeof row === 'object') rows.push(row)
    }
  }
  if (Array.isArray(payload?.images)) {
    for (const row of payload.images) {
      if (typeof row === 'string') rows.push({ url: row })
      else if (row && typeof row === 'object') rows.push(row)
    }
  }
  if (Array.isArray(payload?.output)) {
    for (const row of payload.output) {
      if (row && typeof row === 'object' && typeof row.b64_json === 'string') rows.push(row)
    }
  }
  return rows
}

async function fetchToBuffer(url, signal) {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new UpstreamError(`Could not download the generated image (HTTP ${response.status}).`, {
      status: response.status,
      code: 'download',
      retryable: response.status >= 500 || response.status === 429,
    })
  }
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Ask the upstream for `n` pictures.
 *
 * @returns `{ images: [{buffer, mediaType}], size, usage, trace, attempts, keyId }`
 */
export async function renderImages(options) {
  const config = options.config
  const provider = providerProfile(config)
  const prompt = String(options.prompt ?? '')
  if (prompt.trim().length === 0) throw new UpstreamError('A prompt is required.', { code: 'bad_request' })
  const model = options.model || config.models?.default
  const images = Array.isArray(options.images) ? options.images.filter((image) => image && image.buffer) : []
  const wanted = Math.max(1, Math.min(4, Math.round(options.n ?? 1)))
  const size = parseSize(options.size)?.text ?? config.request?.size ?? '1024x1024'
  const pathname = images.length > 0
    ? (config.upstream?.editPath ?? config.upstream?.imagesPath ?? '/images/generations')
    : (config.upstream?.imagesPath ?? '/images/generations')

  // One request per picture when the provider only returns one, or when editing
  // (an edit is inherently about the specific input).
  const perRequest = provider.onePerRequest || images.length > 0 ? 1 : wanted
  const rounds = images.length > 0 ? Math.max(1, wanted) : Math.ceil(wanted / perRequest)

  const collected = []
  const traces = []
  let lastUsage = null
  let lastKeyId = ''
  let attempts = 0
  let resolvedSize = size

  for (let round = 0; round < rounds; round += 1) {
    if (options.signal?.aborted) throw new UpstreamError('cancelled', { code: 'aborted' })
    const body = buildBody({
      provider,
      model,
      prompt,
      size,
      n: perRequest,
      images: images.length > 0 ? (images.length === 1 ? images : [images[Math.min(round, images.length - 1)]]) : [],
      config,
    })
    const result = await callUpstream(pathname, body, {
      config,
      signal: options.signal,
      onAttempt: options.onAttempt,
      pool: options.pool,
    })
    attempts += result.attempt
    lastKeyId = result.keyId
    traces.push(...result.trace)
    if (typeof result.payload?.size === 'string' && result.payload.size.includes('x')) resolvedSize = result.payload.size
    if (result.payload?.usage) lastUsage = result.payload.usage
    for (const entry of entriesOf(result.payload)) {
      if (typeof entry.b64_json === 'string') {
        collected.push({ buffer: Buffer.from(entry.b64_json, 'base64'), mediaType: 'image/png' })
      } else if (typeof entry.url === 'string') {
        collected.push({ buffer: await fetchToBuffer(entry.url, options.signal), mediaType: 'image/png' })
      } else if (typeof entry.base64 === 'string') {
        collected.push({ buffer: Buffer.from(entry.base64, 'base64'), mediaType: 'image/png' })
      }
    }
    if (collected.length >= wanted) break
  }

  if (collected.length === 0) {
    throw new UpstreamError('The upstream returned no image.', { code: 'empty_result' })
  }

  const images2 = []
  for (const row of collected.slice(0, wanted)) {
    const info = await assertStill(row.buffer, 'generated image')
    images2.push({ buffer: row.buffer, mediaType: row.mediaType, width: info.width, height: info.height, format: info.format })
  }

  return {
    images: images2,
    size: resolvedSize,
    usage: lastUsage,
    trace: traces,
    attempts,
    keyId: lastKeyId,
  }
}

/** Ask the upstream for its model list (used by the settings page probe). */
export async function probeModels(config) {
  const url = `${baseUrl(config)}${config.upstream?.modelsPath ?? '/models'}`
  const result = await postJson(url, {}, { config })
  return result.payload
}

export { parseSize, aspectOf }
