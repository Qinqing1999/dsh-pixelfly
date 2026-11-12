// dsh-pixelfly — the vision side.
//
// Several operations cannot be expressed as one image prompt. "Replace the head
// with this dog", "remove the watermark", "split the visible text into editable
// regions" all need a model that can *look* at the picture first and answer with
// a plan. This module owns that conversation:
//
//   * it builds the request in whichever of three wire formats the settings name
//     (chat completions, Anthropic messages, or the Responses API),
//   * it insists on a JSON answer and tolerates the usual ways models wrap one,
//   * it reports a structured failure when the plan is unusable.
//
// Vision is optional by design. An operation that has a plain prompt fallback
// still runs when no vision model is configured; only the operations that
// genuinely need planning (regional replacement with a reference, text
// recognition, watermark location) require one.

import { postJson, UpstreamError } from './upstream.js'

export class VisionError extends Error {
  constructor(message, code = 'vision.plan') {
    super(message)
    this.name = 'VisionError'
    this.code = code
  }
}

/**
 * Strip the ways a model can wrap JSON: a fenced block, a leading sentence, a
 * trailing apology. Returns the first balanced object found.
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = []
  if (fenced) candidates.push(fenced[1])
  candidates.push(text)
  for (const candidate of candidates) {
    const start = candidate.indexOf('{')
    if (start < 0) continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < candidate.length; index += 1) {
      const char = candidate[index]
      if (escaped) { escaped = false; continue }
      if (char === '\\') { escaped = true; continue }
      if (char === '"') { inString = !inString; continue }
      if (inString) continue
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, index + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  return null
}

function dataUrl(image) {
  return `data:${image.mediaType ?? 'image/png'};base64,${Buffer.from(image.buffer).toString('base64')}`
}

/**
 * Build the message parts for a request.
 *
 * Images are labelled in the text as "image 1", "image 2"… in the order they are
 * attached, because prompts in this plugin refer to them by position.
 */
export function buildMessages({ instruction, images = [], context }) {
  const parts = []
  if (typeof context === 'string' && context.trim().length > 0) {
    parts.push({ type: 'text', text: context.trim() })
  }
  for (let index = 0; index < images.length; index += 1) {
    parts.push({ type: 'text', text: `Image ${index + 1}:` })
    parts.push({ type: 'image_url', image_url: { url: dataUrl(images[index]) } })
  }
  parts.push({ type: 'text', text: instruction })
  return [{ role: 'user', content: parts }]
}

/** Pull the assistant text out of a chat-completions response. */
export function readCompletion(payload) {
  const choice = payload?.choices?.[0]
  if (!choice) return ''
  const message = choice.message ?? {}
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('')
  }
  if (typeof choice.text === 'string') return choice.text
  return ''
}

/** Pull the assistant text out of an Anthropic messages response. */
export function readAnthropicText(payload) {
  if (Array.isArray(payload?.content)) {
    return payload.content
      .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('')
  }
  return typeof payload?.completion === 'string' ? payload.completion : ''
}

/** Pull the assistant text out of a Responses API answer. */
export function readResponsesText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.length > 0) return payload.output_text
  const rows = []
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (typeof part?.text === 'string') rows.push(part.text)
      else if (typeof part?.output_text === 'string') rows.push(part.output_text)
    }
  }
  return rows.join('')
}

/**
 * Which wire format the vision calls use.
 *
 * The default is chat completions because that is what nearly every gateway
 * speaks. The other two exist for the cases where it is not: Anthropic-style
 * `/messages` endpoints, and the Responses API whose image parts and output
 * envelope differ from both.
 */
export function visionFormat(config) {
  const raw = String(config?.upstream?.visionFormat ?? 'chat').trim().toLowerCase()
  if (raw === 'anthropic' || raw === 'messages') return 'anthropic'
  if (raw === 'responses') return 'responses'
  return 'chat'
}

/** Anthropic content blocks for one call. */
function anthropicMessages({ instruction, images = [], context }) {
  const blocks = []
  if (typeof context === 'string' && context.trim().length > 0) blocks.push({ type: 'text', text: context.trim() })
  for (let index = 0; index < images.length; index += 1) {
    blocks.push({ type: 'text', text: `Image ${index + 1}:` })
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: images[index].mediaType ?? 'image/png',
        data: Buffer.from(images[index].buffer).toString('base64'),
      },
    })
  }
  blocks.push({ type: 'text', text: instruction })
  return [{ role: 'user', content: blocks }]
}

/** Responses API input items for one call. */
function responsesInput({ instruction, images = [], context }) {
  const parts = []
  if (typeof context === 'string' && context.trim().length > 0) parts.push({ type: 'input_text', text: context.trim() })
  for (let index = 0; index < images.length; index += 1) {
    parts.push({ type: 'input_text', text: `Image ${index + 1}:` })
    parts.push({ type: 'input_image', image_url: dataUrl(images[index]) })
  }
  parts.push({ type: 'input_text', text: instruction })
  return [{ role: 'user', content: parts }]
}

/**
 * Build the URL, body, headers and text reader for one round of a vision call.
 *
 * `nudge` is appended as a second user turn on the retry round; each format has
 * its own place for it, so the shape is decided here rather than at the call site.
 */
export function buildVisionCall({ config, model, instruction, images, context, nudge = '', jsonMode = true }) {
  const format = visionFormat(config)
  const base = config.upstream.baseUrl.replace(/\/+$/, '')
  if (format === 'anthropic') {
    const messages = anthropicMessages({ instruction, images, context })
    if (nudge) messages.push({ role: 'user', content: [{ type: 'text', text: nudge }] })
    return {
      format,
      url: `${base}/messages`,
      body: {
        model,
        max_tokens: 4000,
        temperature: 0.2,
        messages,
      },
      extraHeaders: { 'anthropic-version': '2023-06-01' },
      timeoutMs: config.upstream?.visionTimeoutMs,
      read: (payload) => readAnthropicText(payload),
    }
  }
  if (format === 'responses') {
    const input = responsesInput({ instruction, images, context })
    if (nudge) input.push({ role: 'user', content: [{ type: 'input_text', text: nudge }] })
    return {
      format,
      url: `${base}/responses`,
      body: {
        model,
        input,
        max_output_tokens: 4000,
        temperature: 0.2,
        ...(jsonMode ? { text: { format: { type: 'json_object' } } } : {}),
      },
      extraHeaders: {},
      timeoutMs: config.upstream?.visionTimeoutMs,
      read: (payload) => readResponsesText(payload),
    }
  }
  const messages = buildMessages({ instruction, images, context })
  if (nudge) messages.push({ role: 'user', content: nudge })
  return {
    format,
    url: `${base}/chat/completions`,
    body: {
      model,
      messages,
      temperature: 0.2,
      max_tokens: 4000,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    },
    extraHeaders: {},
    timeoutMs: config.upstream?.visionTimeoutMs,
    read: (payload) => readCompletion(payload),
  }
}

/**
 * Ask the vision model for a JSON plan.
 *
 * `schemaHint` is prose rather than a JSON Schema on purpose: the upstream chat
 * API in play has inconsistent structured-output support, so the contract is
 * stated in the prompt and enforced by `validate` afterwards. A model that
 * answers with prose gets one retry with a sharper instruction before failing.
 */
export async function planJson({ config, model, instruction, images, context, validate, signal, onAttempt }) {
  let lastError = null
  for (let round = 1; round <= 2; round += 1) {
    const nudge = round === 1
      ? ''
      : 'Your previous answer was not valid JSON. Reply with the JSON object only — no prose, no code fence.'
    const call = buildVisionCall({ config, model, instruction, images, context, nudge })
    let payload
    try {
      payload = await postJson(call.url, call.body, {
        config,
        signal,
        onAttempt,
        extraHeaders: call.extraHeaders,
        timeoutMs: call.timeoutMs,
      })
    } catch (error) {
      // Some gateways reject a JSON-output mode outright. Retry once without it
      // rather than reporting the gateway's complaint as the model's failure.
      const rejectsMode = error instanceof UpstreamError && (error.status === 400 || error.status === 422)
      if (!rejectsMode) throw error
      const relaxed = buildVisionCall({ config, model, instruction, images, context, nudge, jsonMode: false })
      payload = await postJson(relaxed.url, relaxed.body, {
        config,
        signal,
        onAttempt,
        extraHeaders: relaxed.extraHeaders,
        timeoutMs: relaxed.timeoutMs,
      })
    }
    // `postJson` returns the whole call envelope (payload, attempt, keyId, trace);
    // the answer body is nested inside it.
    const text = call.read(payload?.payload ?? payload)
    const parsed = extractJson(text)
    if (parsed === null) {
      lastError = new VisionError('The vision model did not answer with JSON', 'vision.notJson')
      continue
    }
    try {
      return validate(parsed)
    } catch (error) {
      // A well-formed answer that says "this does not apply" is a verdict, not a
      // malformed reply. Retrying it would only burn another request and then
      // report the retry's own failure instead of the model's actual judgement.
      if (error?.name === 'OperationError' || error?.final === true) throw error
      lastError = error
    }
  }
  throw lastError ?? new VisionError('The vision model did not produce a usable plan', 'vision.plan')
}

/** A vision model row from the discovered model list, or a clear failure. */
export function visionModelOrThrow(config, modelId) {
  const items = Array.isArray(config.models?.visionItems) ? config.models.visionItems : []
  // An empty string is what "nothing was chosen" looks like after a workspace round
  // trip, and `??` does not treat it as absent, so it has to be normalised here or a
  // configured default would never be used.
  const chosen = typeof modelId === 'string' && modelId.trim().length > 0 ? modelId.trim() : ''
  const id = chosen || config.models?.visionDefault || ''
  const found = items.find((item) => item.id === id)
  if (!found) {
    throw new VisionError(
      id
        ? `Vision model "${id}" is not configured. Add it in the PixelFly settings.`
        : 'This operation needs a vision model. Choose one in the PixelFly settings.',
      'vision.missing',
    )
  }
  return found
}

/** The vision models known to work with an image part. */
export const DEFAULT_VISION_MODELS = [
  { id: 'sensenova-6.8-flash', label: 'SenseNova 6.8 Flash' },
  { id: 'sensenova-6.8-flash-lite', label: 'SenseNova 6.8 Flash Lite' },
]
