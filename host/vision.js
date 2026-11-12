// dsh-pixelfly — the vision side.
//
// Several operations cannot be expressed as one image prompt. "Replace the head
// with this dog", "remove the watermark", "split the visible text into editable
// regions" all need a model that can *look* at the picture first and answer with
// a plan. This module owns that conversation:
//
//   * it builds a chat-completions request with image parts,
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

/**
 * Ask the vision model for a JSON plan.
 *
 * `schemaHint` is prose rather than a JSON Schema on purpose: the upstream chat
 * API in play has inconsistent structured-output support, so the contract is
 * stated in the prompt and enforced by `validate` afterwards. A model that
 * answers with prose gets one retry with a sharper instruction before failing.
 */
export async function planJson({ config, model, instruction, images, context, validate, signal, onAttempt }) {
  const messages = buildMessages({ instruction, images, context })
  let lastError = null
  for (let round = 1; round <= 2; round += 1) {
    const reminder = round === 1
      ? ''
      : '\n\nYour previous answer was not valid JSON. Reply with the JSON object only — no prose, no code fence.'
    const body = {
      model,
      messages: round === 1 ? messages : [...messages, { role: 'user', content: `Reply with the JSON object only.${reminder}` }],
      temperature: 0.2,
      max_tokens: 4000,
      response_format: { type: 'json_object' },
    }
    let payload
    try {
      payload = await postJson(`${config.upstream.baseUrl.replace(/\/+$/, '')}/chat/completions`, body, {
        config,
        signal,
        onAttempt,
      })
    } catch (error) {
      if (error instanceof UpstreamError && (error.status === 400 || error.status === 422)) {
        // Some gateways reject response_format; retry once without it rather than failing.
        const relaxed = { ...body }
        delete relaxed.response_format
        payload = await postJson(`${config.upstream.baseUrl.replace(/\/+$/, '')}/chat/completions`, relaxed, {
          config,
          signal,
          onAttempt,
        })
      } else {
        throw error
      }
    }
    // `postJson` returns the whole call envelope (payload, attempt, keyId, trace);
    // the chat body is nested inside it.
    const text = readCompletion(payload?.payload ?? payload)
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
