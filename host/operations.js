// dsh-pixelfly — the operations.
//
// Every way of changing a picture is one entry in `OPERATIONS`. An operation
// takes the current image (if any), the user's instruction, and returns the new
// bytes plus a record of what it did. Keeping them behind one shape means the
// routes, the tools and the studio all share a single vocabulary.
//
// Three rules run through all of them:
//
//   1. A local change must not disturb the rest of the picture. When an operation
//      works on a selection, the model's answer is blended back into the original
//      pixels and everything outside the selection is byte-identical.
//   2. An operation that depends on *looking* at the picture asks the vision model
//      first, and fails with a clear message when no vision model is configured
//      rather than guessing.
//   3. A failure is data, not an exception to swallow: batch runners collect them
//      per item so one bad prompt does not lose the other forty.

import { sizesFor } from './config.js'
import {
  RasterError,
  assertDimensions,
  assertStill,
  changedOutsideRatio,
  closestSize,
  cropWithMargin,
  extractPixels,
  overlayRegion,
  extendCanvas,
  magnify,
  normalizeForProvider,
  normalizeRect,
  pasteRegion,
  pasteRegions,
  seamGap,
  probe,
  cutoutByFloodFill,
  toPng,
  toTransparentPng,
  transparencyReport,
} from './raster.js'
import { renderImages } from './providers.js'
import { VisionError, planJson, visionModelOrThrow } from './vision.js'
import { UpstreamError } from './upstream.js'

export class OperationError extends Error {
  constructor(message, code = 'operation', status = 400) {
    super(message)
    this.name = 'OperationError'
    this.code = code
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Trim a prompt and refuse an empty one with an actionable message. */
function requirePrompt(prompt, limit = 12000) {
  const text = typeof prompt === 'string' ? prompt.trim() : ''
  if (text.length === 0) throw new OperationError('A prompt is required', 'no_prompt')
  return text.slice(0, limit)
}

/** Append the workspace style prompt, if any, as a separate clause. */
function withStyle(prompt, stylePrompt) {
  const style = typeof stylePrompt === 'string' ? stylePrompt.trim() : ''
  if (style.length === 0) return prompt
  return `${prompt}\n\nStyle: ${style}`
}

/** Downscale a picture before handing it to the vision model. */
async function forVision(buffer, maxSide) {
  const png = await toPng(buffer, { maxSide })
  return { buffer: png.buffer, mediaType: 'image/png' }
}

/** Render one picture and return the decoded bytes. */
async function renderOne(context, { prompt, model, size, images }) {
  const result = await renderImages({
    config: context.config,
    prompt,
    model: model ?? context.model,
    size,
    n: 1,
    images,
    signal: context.signal,
    onAttempt: context.onAttempt,
    pool: context.pool,
  })
  return { image: result.images[0], result }
}

/**
 * Edit an existing picture and resize the answer back to the source size.
 *
 * Image models treat `size: 'auto'` with an input picture as "pick a canvas for
 * me", so the answer almost never matches the source. Resizing back is what makes
 * the result a drop-in replacement.
 */
async function editSource(context, { prompt, source, size, extraImages = [], label }) {
  const info = await assertStill(source.buffer, label ?? 'source image')
  const preferred = size ?? closestSize(info.width, info.height, sizesFor(context.config))
  const normalized = await normalizeForProvider(source.buffer, preferred)
  const inputs = [normalized, ...extraImages]
  const { image, result } = await renderOne(context, {
    prompt,
    size: preferred,
    images: inputs.map((row) => ({ buffer: row.buffer, mediaType: row.mediaType })),
  })
  const back = await toPng(image.buffer, { maxSide: 8192 })
  const resized = await resizeTo(back.buffer, info.width, info.height)
  return { buffer: resized, mediaType: 'image/png', width: info.width, height: info.height, result }
}

async function resizeTo(buffer, width, height) {
  const { default: sharp } = await import('sharp')
  return sharp(buffer).resize(width, height, { fit: 'fill' }).png().toBuffer()
}

/** A vision plan that must say whether the request makes sense at all. */
function applicabilityValidator(shape) {
  return (parsed) => {
    if (parsed && parsed.applicable === false) {
      throw new OperationError(
        typeof parsed.reason === 'string' && parsed.reason.length > 0
          ? parsed.reason
          : 'The vision model judged this edit does not apply to the picture',
        'not_applicable',
        422,
      )
    }
    return shape(parsed)
  }
}

function requireVisionModel(context, explicit) {
  // The same empty-string trap as in vision.js: a blank selection must fall through
  // to the configured default rather than count as a chosen model.
  const picked = typeof explicit === 'string' && explicit.trim().length > 0 ? explicit.trim() : ''
  const fallback = typeof context.visionModel === 'string' && context.visionModel.trim().length > 0 ? context.visionModel.trim() : ''
  return visionModelOrThrow(context.config, picked || fallback).id
}

// ---------------------------------------------------------------------------
// text to image
// ---------------------------------------------------------------------------

async function text2image(input, context) {
  const prompt = withStyle(requirePrompt(input.prompt), input.stylePrompt ?? context.stylePrompt)
  const n = Math.max(1, Math.min(4, Math.round(input.n ?? 1)))
  const size = input.size ?? context.config.request?.size ?? '1024x1024'
  const result = await renderImages({
    config: context.config,
    prompt,
    model: input.model ?? context.model,
    size,
    n,
    signal: context.signal,
    onAttempt: context.onAttempt,
    pool: context.pool,
  })
  return {
    images: result.images,
    prompt,
    label: `Text to image · ${n} image${n > 1 ? 's' : ''}`,
    meta: { size: result.size, usage: result.usage, attempts: result.attempts, keyId: result.keyId, trace: result.trace },
  }
}

// ---------------------------------------------------------------------------
// prompt editing (image to image)
// ---------------------------------------------------------------------------

async function edit(input, context) {
  const source = requireSource(input, context)
  const prompt = withStyle(requirePrompt(input.prompt), input.stylePrompt ?? context.stylePrompt)
  const extra = []
  if (input.reference?.buffer) {
    const reference = await normalizeForProvider(input.reference.buffer)
    extra.push({ buffer: reference.buffer, mediaType: reference.mediaType })
  }
  const out = await editSource(context, { prompt, source, size: input.size, extraImages: extra })
  return {
    images: [{ buffer: out.buffer, mediaType: out.mediaType }],
    prompt,
    label: 'Prompt edit',
    meta: { size: `${out.width}x${out.height}`, usage: out.result.usage, attempts: out.result.attempts, keyId: out.result.keyId, trace: out.result.trace },
  }
}

// ---------------------------------------------------------------------------
// regional editing
// ---------------------------------------------------------------------------

const REGION_VISION = [
  'You are planning a local retouch. Image 1 is the full picture; the user selected the box given below.',
  'Rewrite the user request as one precise instruction that changes ONLY what is inside that box and',
  'leaves the rest of the frame untouched. Name what is there now and what it should become.',
  'Return strict JSON: {"applicable":true,"subject":"what is in the box","edit_prompt":"the instruction"}',
  'Set "applicable" to false with a "reason" when the request cannot be done inside that box.',
].join(' ')

async function localEdit(input, context) {
  const source = requireSource(input, context)
  const prompt = requirePrompt(input.prompt)
  const info = await assertStill(source.buffer)
  const rects = normaliseRects(input.rects ?? input.rect, 'selection')
  const primary = rects[0]
  const box = `Selection: x ${primary.x.toFixed(1)}%, y ${primary.y.toFixed(1)}%, width ${primary.width.toFixed(1)}%, height ${primary.height.toFixed(1)}% of the picture.`

  let planned = prompt
  let visionUsed = ''
  if (context.config.models?.visionDefault || input.visionModel || input.plan !== false) {
    try {
      const model = requireVisionModel(context, input.visionModel)
      visionUsed = model
      const small = await forVision(source.buffer, context.config.limits?.visionMaxSide ?? 768)
      const zoom = await magnify(source.buffer, primary)
      const plan = await planJson({
        config: context.config,
        model,
        instruction: `${REGION_VISION}\n\n${box}\n\nUser request: ${prompt}`,
        images: [small, await forVision(zoom.buffer, context.config.limits?.visionMaxSide ?? 768)],
        validate: applicabilityValidator((parsed) => ({
          applicable: true,
          subject: typeof parsed?.subject === 'string' ? parsed.subject : '',
          editPrompt: typeof parsed?.edit_prompt === 'string' && parsed.edit_prompt.trim().length > 0
            ? parsed.edit_prompt.trim()
            : prompt,
        })),
        signal: context.signal,
        onAttempt: context.onAttempt,
      })
      planned = plan.editPrompt
    } catch (error) {
      if (error instanceof OperationError && error.code === 'not_applicable') throw error
      // No vision model, or it declined to plan: fall back to the user's own words.
      if (!(error instanceof VisionError)) throw error
      planned = prompt
    }
  }

  const instruction = [
    `Edit only the region at x ${primary.x.toFixed(1)}%, y ${primary.y.toFixed(1)}%, width ${primary.width.toFixed(1)}%, height ${primary.height.toFixed(1)}%.`,
    planned,
    'Keep every other part of the picture exactly as it is: same framing, same lighting, same colours outside that region.',
  ].join('\n')

  const extra = []
  if (input.reference?.buffer) {
    const reference = await normalizeForProvider(input.reference.buffer)
    extra.push({ buffer: reference.buffer, mediaType: reference.mediaType })
    instruction += '\nImage 2 is a reference for the result; take its subject, colour and material.'
  }

  // Send a padded crop instead of the whole frame: the model then has real surrounding
  // pixels touching the area to change and continues them, where a whole-frame request
  // tends to paint the box as its own little picture with its own backdrop.
  const crop = await cropWithMargin(source.buffer, primary, {
    margin: 0.35,
    minSide: 512,
    maxSide: Math.max(1024, Math.round(context.config.limits?.visionMaxSide ?? 768) * 2),
  })
  const cropInstruction = [
    `Change only the area from x ${crop.inner.left}px, y ${crop.inner.top}px, width ${crop.inner.width}px, height ${crop.inner.height}px of this ${crop.width}x${crop.height} crop.`,
    planned,
    'Everything outside that area is already correct: continue its light, colour and texture into the changed area so the join is invisible.',
  ].join('\n')
  const cropInputs = [crop]
  let finalInstruction = cropInstruction
  if (extra.length > 0) {
    cropInputs.push(...extra)
    finalInstruction += '\nImage 2 is a reference for the result; take its subject, colour and material.'
  }
  const rendered = await renderOne(context, {
    prompt: finalInstruction,
    size: closestSize(crop.width, crop.height, sizesFor(context.config)),
    images: cropInputs.map((row) => ({ buffer: row.buffer, mediaType: row.mediaType })),
  })
  // The answer covers the whole crop, but only the part that lines up with the
  // selection may be pasted back — taking the full answer would drop a chunk of the
  // surrounding picture over the region and leave a visible box.
  const answer = await toPng(rendered.image.buffer, { maxSide: 8192 })
  const scaleBack = answer.width / crop.width
  const patch = await extractPixels(answer.buffer, {
    left: crop.inner.left * scaleBack,
    top: crop.inner.top * scaleBack,
    width: crop.inner.width * scaleBack,
    height: crop.inner.height * scaleBack,
  })
  const overlaid = await overlayRegion(source.buffer, patch.buffer, primary)
  const generated = {
    buffer: overlaid,
    mediaType: 'image/png',
    width: info.width,
    height: info.height,
    result: rendered.result,
  }

  // The answer is already a composite of the old frame with the new patch, so it can
  // never be returned as-is: its border is a hard edge by construction. Feathering it
  // back into the original is what turns that edge into a gradient. The two measures
  // below are recorded for diagnostics — they describe how far the model's patch sits
  // from the surrounding picture, which is what makes a join look wrong.
  const drift = await changedOutsideRatio(source.buffer, generated.buffer, primary)
  const gap = await seamGap(source.buffer, generated.buffer, primary)
  const composed = await pasteRegion(source.buffer, generated.buffer, primary)
  const check = await probe(composed.buffer)
  if (check.width !== info.width || check.height !== info.height) {
    throw new OperationError('The local edit did not come back at the source size', 'bad_size', 500)
  }
  return {
    images: [{ buffer: composed.buffer, mediaType: 'image/png' }],
    prompt,
    label: `Local edit · ${Math.round(primary.width)}%×${Math.round(primary.height)}%`,
    meta: {
      rect: primary,
      rects,
      planned,
      method: 'crop-paste',
      drift: Number(drift.toFixed(4)),
      seamGap: Number(gap.toFixed(1)),
      visionModel: visionUsed,
      usage: generated.result.usage,
      attempts: generated.result.attempts,
      keyId: generated.result.keyId,
      trace: generated.result.trace,
    },
  }
}

/** Several instructions against the same selection become several versions' worth of output. */
async function localEditBatch(input, context) {
  const instructions = (Array.isArray(input.instructions) ? input.instructions : [])
    .map((row) => String(row ?? '').trim())
    .filter((row) => row.length > 0)
  if (instructions.length === 0) throw new OperationError('Give at least one instruction', 'no_prompt')
  const cap = Math.max(2, Math.min(50, Math.round(context.config.limits?.maxBatch ?? 50)))
  const chosen = instructions.slice(0, cap)
  const images = []
  const failures = []
  const metas = []
  for (let index = 0; index < chosen.length; index += 1) {
    if (context.signal?.aborted) break
    try {
      const one = await localEdit({ ...input, prompt: chosen[index], plan: false }, context)
      images.push(one.images[0])
      metas.push(one.meta)
      context.onItem?.({ index, total: chosen.length, ok: true, prompt: chosen[index] })
    } catch (error) {
      failures.push({ index, prompt: chosen[index], message: error.message })
      context.onItem?.({ index, total: chosen.length, ok: false, prompt: chosen[index], message: error.message })
    }
  }
  if (images.length === 0) {
    throw new OperationError(failures[0]?.message ?? 'Every instruction failed', 'all_failed', 502)
  }
  return {
    images,
    prompt: chosen.join('\n'),
    label: `Local edit batch · ${images.length}/${chosen.length}`,
    meta: { failures, items: metas },
  }
}

// ---------------------------------------------------------------------------
// fusion (a reference dropped onto the target)
// ---------------------------------------------------------------------------

const FUSION_MODES = {
  basic: 'Blend the reference subject into the picture at the dropped position, matching perspective, light direction and shadow.',
  outfit: 'Replace the clothing of the person in the picture with the garment shown in the reference. Keep the person\'s face, pose, hair and the background unchanged; match the fabric, colour and folds to the scene lighting.',
  pose: 'Make the person in the picture take the pose shown in the reference. Keep the person\'s face, clothing and the background unchanged.',
  group: 'Add the person or subject from the reference into the picture beside the existing subjects, as if they were photographed together. Match scale, perspective, light direction and colour temperature.',
}

async function fusion(input, context) {
  const source = requireSource(input, context)
  const reference = input.reference
  if (!reference?.buffer) throw new OperationError('Fusion needs a reference image', 'no_reference')
  const info = await assertStill(reference.buffer, 'reference')
  if (info.width < 16 || info.height < 16) throw new OperationError('The reference image is too small', 'bad_reference')
  const mode = FUSION_MODES[input.mode] ? input.mode : 'basic'
  const note = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  const target = await assertStill(source.buffer)

  // Where the reference was dropped, as a percentage box on the target.
  const rect = input.rect ? normalizeRect(input.rect, 'drop position') : null

  let planned = ''
  let visionUsed = ''
  try {
    const model = requireVisionModel(context, input.visionModel)
    visionUsed = model
    const smallTarget = await forVision(source.buffer, context.config.limits?.visionMaxSide ?? 768)
    const smallRef = await forVision(reference.buffer, context.config.limits?.visionMaxSide ?? 768)
    const position = rect
      ? `The reference was dropped centred at x ${(rect.x + rect.width / 2).toFixed(1)}%, y ${(rect.y + rect.height / 2).toFixed(1)}%, covering about ${rect.width.toFixed(1)}% of the width.`
      : 'No drop position was given; place the reference naturally.'
    const plan = await planJson({
      config: context.config,
      model,
      instruction: [
        'Image 1 is the target picture, image 2 is the reference.',
        'Describe how to combine them for the requested operation.',
        position,
        `Operation: ${FUSION_MODES[mode]}`,
        note.length > 0 ? `User note: ${note}` : '',
        'Return strict JSON: {"applicable":true,"plan":"one precise paragraph for an image editor"}',
        'Set "applicable" to false with a "reason" when the two pictures cannot be combined this way.',
      ].filter(Boolean).join('\n'),
      images: [smallTarget, smallRef],
      validate: applicabilityValidator((parsed) => ({
        applicable: true,
        plan: typeof parsed?.plan === 'string' && parsed.plan.trim().length > 0 ? parsed.plan.trim() : '',
      })),
      signal: context.signal,
      onAttempt: context.onAttempt,
    })
    planned = plan.plan
  } catch (error) {
    if (error instanceof OperationError && error.code === 'not_applicable') throw error
    if (!(error instanceof VisionError)) throw error
    planned = ''
  }

  const instruction = [
    'Image 1 is the picture to change, image 2 is the reference.',
    FUSION_MODES[mode],
    rect ? `Place the reference subject centred at x ${(rect.x + rect.width / 2).toFixed(1)}%, y ${(rect.y + rect.height / 2).toFixed(1)}% of the frame.` : '',
    planned,
    note,
  ].filter((row) => typeof row === 'string' && row.length > 0).join('\n')

  const out = await editSource(context, {
    prompt: instruction,
    source,
    extraImages: [{ buffer: reference.buffer, mediaType: reference.mediaType ?? 'image/png' }],
  })
  return {
    images: [{ buffer: out.buffer, mediaType: 'image/png' }],
    prompt: note || FUSION_MODES[mode],
    label: `Fusion · ${mode}`,
    meta: {
      mode,
      rect,
      planned,
      visionModel: visionUsed,
      sourceSize: `${target.width}x${target.height}`,
      usage: out.result.usage,
      attempts: out.result.attempts,
      keyId: out.result.keyId,
      trace: out.result.trace,
    },
  }
}

// ---------------------------------------------------------------------------
// batch: variables and prompt lists
// ---------------------------------------------------------------------------

/**
 * Expand `[name]` tags against a value map into one prompt per combination.
 *
 * The cartesian product is capped before any request is made, so a user who
 * types six variables with four values each learns the cost up front instead of
 * after forty pictures have been billed.
 */
export function expandVariables(prompt, values, cap = 50) {
  const names = []
  for (const match of String(prompt).matchAll(/\[([^\[\]\n]{1,40})\]/g)) {
    if (!names.includes(match[1])) names.push(match[1])
  }
  if (names.length === 0) throw new OperationError('Add at least one [variable] to the prompt', 'no_variable')
  const lists = names.map((name) => {
    const raw = values?.[name]
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\r?\n/) : []
    const cleaned = list.map((row) => String(row ?? '').trim()).filter((row) => row.length > 0)
    if (cleaned.length === 0) throw new OperationError(`Variable [${name}] has no values`, 'empty_variable')
    return { name, list: cleaned }
  })
  const combos = []
  const walk = (index, current) => {
    if (combos.length >= cap) return
    if (index === lists.length) {
      combos.push(current)
      return
    }
    for (const value of lists[index].list) {
      if (combos.length >= cap) return
      walk(index + 1, { ...current, [lists[index].name]: value })
    }
  }
  walk(0, {})
  const prompts = combos.map((combo) => {
    let text = String(prompt)
    for (const [name, value] of Object.entries(combo)) {
      text = text.split(`[${name}]`).join(value)
    }
    return { prompt: text, values: combo }
  })
  return { names, prompts, truncated: combos.length >= cap }
}

async function batchVariables(input, context) {
  const prompt = requirePrompt(input.prompt)
  const cap = Math.max(2, Math.min(50, Math.round(context.config.limits?.maxBatch ?? 50)))
  const expanded = expandVariables(prompt, input.values ?? {}, cap)
  const style = input.stylePrompt ?? context.stylePrompt
  const n = Math.max(1, Math.min(4, Math.round(input.n ?? 1)))
  const images = []
  const failures = []
  const items = []
  let index = 0
  for (const row of expanded.prompts) {
    if (context.signal?.aborted) break
    const finalPrompt = withStyle(row.prompt, style)
    try {
      const result = await renderImages({
        config: context.config,
        prompt: finalPrompt,
        model: input.model ?? context.model,
        size: input.size,
        n,
        signal: context.signal,
        onAttempt: context.onAttempt,
        pool: context.pool,
      })
      for (const image of result.images) images.push(image)
      items.push({ index, prompt: finalPrompt, values: row.values, ok: true, keyId: result.keyId })
    } catch (error) {
      failures.push({ index, prompt: finalPrompt, values: row.values, message: error.message })
      items.push({ index, prompt: finalPrompt, values: row.values, ok: false, message: error.message })
    }
    context.onItem?.({ index, total: expanded.prompts.length, ok: items[items.length - 1].ok, prompt: finalPrompt })
    index += 1
  }
  if (images.length === 0) throw new OperationError(failures[0]?.message ?? 'Every combination failed', 'all_failed', 502)
  return {
    images,
    prompt,
    label: `Variable batch · ${images.length} image${images.length > 1 ? 's' : ''}`,
    meta: { variables: expanded.names, items, failures, truncated: expanded.truncated },
  }
}

async function batchList(input, context) {
  const lines = (Array.isArray(input.prompts) ? input.prompts : String(input.prompts ?? '').split(/\r?\n/))
    .map((row) => String(row ?? '').trim())
    .filter((row) => row.length > 0)
  if (lines.length === 0) throw new OperationError('Give at least one prompt, one per line', 'no_prompt')
  const cap = Math.max(1, Math.min(50, Math.round(context.config.limits?.maxBatch ?? 50)))
  const chosen = lines.slice(0, cap)
  const style = input.stylePrompt ?? context.stylePrompt
  const images = []
  const failures = []
  const items = []
  for (let index = 0; index < chosen.length; index += 1) {
    if (context.signal?.aborted) break
    const finalPrompt = withStyle(chosen[index], style)
    try {
      const result = await renderImages({
        config: context.config,
        prompt: finalPrompt,
        model: input.model ?? context.model,
        size: input.size,
        n: 1,
        signal: context.signal,
        onAttempt: context.onAttempt,
        pool: context.pool,
      })
      images.push(result.images[0])
      items.push({ index, prompt: finalPrompt, ok: true, keyId: result.keyId })
    } catch (error) {
      failures.push({ index, prompt: finalPrompt, message: error.message })
      items.push({ index, prompt: finalPrompt, ok: false, message: error.message })
    }
    context.onItem?.({ index, total: chosen.length, ok: items[items.length - 1].ok, prompt: finalPrompt })
  }
  if (images.length === 0) throw new OperationError(failures[0]?.message ?? 'Every prompt failed', 'all_failed', 502)
  return {
    images,
    prompt: chosen.join('\n'),
    label: `Prompt list · ${images.length}/${chosen.length}`,
    meta: { items, failures, stylePrompt: typeof style === 'string' ? style : '' },
  }
}

// ---------------------------------------------------------------------------
// outpainting
// ---------------------------------------------------------------------------

/**
 * Grow the canvas, then let the model fill the new area.
 *
 * The extended area is filled by mirroring the edge first: that gives the model a
 * plausible continuation to work from instead of a flat colour, and it keeps the
 * original pixels exactly where they were.
 */
async function outpaint(input, context) {
  const source = requireSource(input, context)
  const info = await assertStill(source.buffer)
  const target = String(input.size ?? '')
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(target)
  if (!match) throw new OperationError('Choose a target size for the outpainted canvas', 'no_size')
  let width = Number(match[1])
  let height = Number(match[2])
  if (width < info.width && height < info.height) {
    throw new OperationError('The target canvas must be larger than the picture in at least one direction', 'bad_size')
  }
  width = Math.max(width, info.width)
  height = Math.max(height, info.height)
  const anchor = input.anchor === 'top' ? 'top' : input.anchor === 'bottom' ? 'bottom' : input.anchor === 'left' ? 'left' : input.anchor === 'right' ? 'right' : 'center'
  const left = anchor === 'left' ? 0 : anchor === 'right' ? width - info.width : Math.round((width - info.width) / 2)
  const top = anchor === 'top' ? 0 : anchor === 'bottom' ? height - info.height : Math.round((height - info.height) / 2)
  const extended = await extendCanvas(source.buffer, { width, height, left, top })
  const note = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  const instruction = [
    `Extend this picture to fill the whole ${width}x${height} frame.`,
    'The original picture occupies the box that is already sharp; the rest was filled by mirroring and looks like a seam.',
    'Continue the scene into that area so the result reads as one photograph: same light, same materials, same horizon, no visible border.',
    note,
  ].filter(Boolean).join('\n')
  const { image, result } = await renderOne(context, {
    prompt: instruction,
    size: `${width}x${height}`,
    images: [{ buffer: extended.buffer, mediaType: 'image/png' }],
  })
  const resized = await resizeTo(image.buffer, width, height)
  return {
    images: [{ buffer: resized, mediaType: 'image/png' }],
    prompt: instruction,
    label: `Outpaint · ${width}x${height}`,
    meta: { from: `${info.width}x${info.height}`, to: `${width}x${height}`, anchor, usage: result.usage, keyId: result.keyId, trace: result.trace },
  }
}

// ---------------------------------------------------------------------------
// watermark removal
// ---------------------------------------------------------------------------

const WATERMARK_VISION = [
  'Find the watermark, logo, stamp or overlaid text in this picture.',
  'Give the box that covers it as percentages of the image (0-100, origin top-left), and describe what should be there instead.',
  'Return strict JSON: {"found":true,"rect":{"x":0,"y":0,"width":0,"height":0},"description":"what the covered area should show"}',
  'If there is no watermark, return {"found":false}.',
].join(' ')

async function removeWatermark(input, context) {
  const source = requireSource(input, context)
  const info = await assertStill(source.buffer)
  let rect = input.rect ? normalizeRect(input.rect, 'watermark box') : null
  let description = ''
  let visionUsed = ''
  if (rect === null) {
    const model = requireVisionModel(context, input.visionModel)
    visionUsed = model
    const small = await forVision(source.buffer, context.config.limits?.visionMaxSide ?? 768)
    const plan = await planJson({
      config: context.config,
      model,
      instruction: WATERMARK_VISION,
      images: [small],
      validate: (parsed) => {
        if (parsed?.found === false) {
          throw new OperationError('No watermark was found in this picture', 'not_found', 422)
        }
        const box = parsed?.rect ?? parsed?.box
        const normalized = normalizeRect(box, 'watermark box')
        if (normalized.width * normalized.height > 6000) {
          throw new OperationError('The watermark box covers most of the picture; draw the box yourself instead', 'too_large', 422)
        }
        return {
          rect: normalized,
          description: typeof parsed?.description === 'string' ? parsed.description.slice(0, 500) : '',
        }
      },
      signal: context.signal,
      onAttempt: context.onAttempt,
    })
    rect = plan.rect
    description = plan.description
  }
  const pixel = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  const zoom = await magnify(source.buffer, pixel)
  const instruction = [
    'Remove the watermark or overlaid text from this picture and rebuild what was underneath.',
    `The watermark occupies x ${rect.x.toFixed(1)}%, y ${rect.y.toFixed(1)}%, width ${rect.width.toFixed(1)}%, height ${rect.height.toFixed(1)}%.`,
    description.length > 0 ? `What belongs there: ${description}` : '',
    'Keep the rest of the picture identical.',
  ].filter(Boolean).join('\n')
  const generated = await editSource(context, { prompt: instruction, source, size: input.size })
  const pasted = await pasteRegion(source.buffer, generated.buffer, rect)
  return {
    images: [{ buffer: pasted.buffer, mediaType: 'image/png' }],
    prompt: instruction,
    label: 'Watermark removal',
    meta: { rect, description, visionModel: visionUsed, usage: generated.result.usage, keyId: generated.result.keyId, trace: generated.result.trace, zoom: `${zoom.width}x${zoom.height}` },
  }
}

// ---------------------------------------------------------------------------
// background removal
// ---------------------------------------------------------------------------

const SUBJECT_VISION = [
  'Name the single most important subject of this picture — the thing a viewer would say the photo is of.',
  'Return strict JSON: {"subject":"a short noun phrase","description":"what it looks like, one sentence"}',
].join(' ')

async function removeBackground(input, context) {
  const source = requireSource(input, context)
  const info = await assertStill(source.buffer)
  let subject = ''
  let visionUsed = ''
  try {
    const model = requireVisionModel(context, input.visionModel)
    visionUsed = model
    const small = await forVision(source.buffer, context.config.limits?.visionMaxSide ?? 768)
    const plan = await planJson({
      config: context.config,
      model,
      instruction: SUBJECT_VISION,
      images: [small],
      validate: (parsed) => ({
        subject: typeof parsed?.subject === 'string' && parsed.subject.trim().length > 0 ? parsed.subject.trim().slice(0, 200) : 'the main subject',
        description: typeof parsed?.description === 'string' ? parsed.description.slice(0, 500) : '',
      }),
      signal: context.signal,
      onAttempt: context.onAttempt,
    })
    subject = plan.subject
  } catch (error) {
    if (!(error instanceof VisionError)) throw error
    subject = 'the main subject'
  }
  const instruction = [
    `Cut out ${subject} and return it on a fully transparent background.`,
    'Keep the subject\'s edges, hair and fine detail; do not add a shadow or a new backdrop.',
    'Every pixel that is not part of the subject must be transparent.',
  ].join('\n')
  const { image, result } = await renderOne(context, {
    prompt: instruction,
    size: input.size,
    images: [{ buffer: source.buffer, mediaType: 'image/png' }],
  })
  let transparent = await toTransparentPng(image.buffer)
  let report = await transparencyReport(transparent.buffer)
  let method = 'model'
  // A model that gives up returns either an untouched picture or an empty canvas.
  // Both are valid PNGs, so the shape of the alpha channel is the only evidence.
  // When the model declines, a flat studio backdrop can still be cut out exactly,
  // and that answer is reproducible rather than a second roll of the dice.
  if (report.transparentRatio < 0.02) {
    const cut = await cutoutByFloodFill(image.buffer)
    const cutReport = await transparencyReport(cut.buffer)
    if (cutReport.transparentRatio >= 0.02 && cutReport.visibleRatio >= 0.01) {
      transparent = cut
      report = cutReport
      method = 'flood-fill'
    }
  }
  if (report.transparentRatio < 0.02) {
    throw new OperationError('Nothing was cut out: the model kept the background and the backdrop is not a flat colour. Try a simpler background or paint over what you want gone.', 'opaque', 422)
  }
  if (report.visibleRatio < 0.01) {
    throw new OperationError('The subject was lost and the canvas came back empty. Try again.', 'empty', 422)
  }
  const sized = await resizeTo(transparent.buffer, info.width, info.height)
  return {
    images: [{ buffer: sized, mediaType: 'image/png' }],
    prompt: instruction,
    label: `Background removal · ${subject}`,
    meta: { subject, transparentRatio: Number(report.transparentRatio.toFixed(3)), visibleRatio: Number(report.visibleRatio.toFixed(3)), method, visionModel: visionUsed, usage: result.usage, keyId: result.keyId, trace: result.trace },
  }
}

// ---------------------------------------------------------------------------
// element removal
// ---------------------------------------------------------------------------

const ELEMENT_PRESETS = {
  box: { label: 'Remove boxed area', instruction: 'Remove whatever is inside the marked box and rebuild the background behind it so the area reads as if it had never been there.' },
  bystanders: { label: 'Remove bystanders', instruction: 'Remove the people in the background who are not the main subject, and rebuild the space behind them.' },
  clutter: { label: 'Clear clutter', instruction: 'Remove the loose objects cluttering the scene — stray items on surfaces, cables, packaging, small rubbish — and rebuild the surfaces behind them.' },
  text: { label: 'Clear all text', instruction: 'Remove every piece of overlaid or printed text, signage and lettering, and rebuild the surface underneath each one.' },
  tidy: { label: 'Tidy the room', instruction: 'Tidy the room: put loose items away, straighten what is askew, and clear surfaces, without changing the furniture, the layout or the light.' },
}

const PEOPLE_VISION = [
  'List the people in this picture other than the main subject.',
  'For each one give a box as percentages of the image (0-100, origin top-left).',
  'Return strict JSON: {"people":[{"rect":{"x":0,"y":0,"width":0,"height":0},"description":"who it is"}]}',
  'Return an empty list when there is nobody else.',
].join(' ')

async function removeElement(input, context) {
  const source = requireSource(input, context)
  const info = await assertStill(source.buffer)
  const preset = ELEMENT_PRESETS[input.preset] ? input.preset : 'box'
  const keep = normaliseRects(input.keep ?? [], 'keep marker', { optional: true })
  let rects = normaliseRects(input.rects ?? input.rect ?? [], 'removal box', { optional: true })
  let visionUsed = ''
  let description = ''

  if (rects.length === 0) {
    const model = requireVisionModel(context, input.visionModel)
    visionUsed = model
    const small = await forVision(source.buffer, context.config.limits?.visionMaxSide ?? 768)
    if (preset === 'bystanders') {
      const plan = await planJson({
        config: context.config,
        model,
        instruction: PEOPLE_VISION,
        images: [small],
        validate: (parsed) => {
          const rows = Array.isArray(parsed?.people) ? parsed.people : []
          const boxes = []
          for (const row of rows) {
            try {
              boxes.push(normalizeRect(row?.rect ?? row, 'bystander box'))
            } catch { /* skip a malformed row rather than losing the whole plan */ }
          }
          if (boxes.length === 0) throw new OperationError('No other people were found in this picture', 'not_found', 422)
          return { rects: boxes }
        },
        signal: context.signal,
        onAttempt: context.onAttempt,
      })
      rects = plan.rects
    } else if (preset === 'text') {
      const plan = await planJson({
        config: context.config,
        model,
        instruction: 'Find every region of visible text, lettering or signage. Give each as a percentage box (0-100, origin top-left). Return strict JSON: {"regions":[{"rect":{"x":0,"y":0,"width":0,"height":0},"text":"the words"}]}',
        images: [small],
        validate: (parsed) => {
          const rows = Array.isArray(parsed?.regions) ? parsed.regions : []
          const boxes = []
          for (const row of rows) {
            try { boxes.push(normalizeRect(row?.rect ?? row, 'text box')) } catch { /* skip */ }
          }
          if (boxes.length === 0) throw new OperationError('No text was found in this picture', 'not_found', 422)
          return { rects: boxes.slice(0, 24) }
        },
        signal: context.signal,
        onAttempt: context.onAttempt,
      })
      rects = plan.rects
    } else {
      throw new OperationError('Draw a box around what should be removed', 'no_rect')
    }
  }

  const region = rects.map((rect) => `x ${rect.x.toFixed(1)}%, y ${rect.y.toFixed(1)}%, width ${rect.width.toFixed(1)}%, height ${rect.height.toFixed(1)}%`).join('; ')
  const keepText = keep.length > 0
    ? `\nKeep these areas untouched, they must survive exactly: ${keep.map((rect) => `x ${rect.x.toFixed(1)}%, y ${rect.y.toFixed(1)}%, width ${rect.width.toFixed(1)}%, height ${rect.height.toFixed(1)}%`).join('; ')}`
    : ''
  const instruction = [
    ELEMENT_PRESETS[preset].instruction,
    `The areas to clear are: ${region}.`,
    keepText,
    'Everything outside those areas must stay pixel-for-pixel the same.',
  ].filter(Boolean).join('\n')

  const generated = await editSource(context, { prompt: instruction, source, size: input.size })
  const pasted = await pasteRegions(source.buffer, generated.buffer, rects, keep)
  const check = await probe(pasted.buffer)
  if (check.width !== info.width || check.height !== info.height) {
    throw new OperationError('The removal did not come back at the source size', 'bad_size', 500)
  }
  return {
    images: [{ buffer: pasted.buffer, mediaType: 'image/png' }],
    prompt: instruction,
    label: ELEMENT_PRESETS[preset].label,
    meta: { preset, rects, keep, description, visionModel: visionUsed, usage: generated.result.usage, keyId: generated.result.keyId, trace: generated.result.trace },
  }
}

// ---------------------------------------------------------------------------
// asset extraction
// ---------------------------------------------------------------------------

const ASSET_KINDS = {
  box: 'the object inside the marked box',
  clothing: 'the clothing worn by the main person, laid out flat as a product shot',
  accessory: 'the accessories (bag, jewellery, eyewear, shoes) on the main subject, laid out as a product shot',
  pattern: 'the surface pattern or texture, straightened and shown flat, with no perspective distortion',
  background: 'the background with every foreground subject removed',
}

async function extractAsset(input, context) {
  const source = requireSource(input, context)
  const info = await assertStill(source.buffer)
  const kind = ASSET_KINDS[input.kind] ? input.kind : 'box'
  const rect = input.rect ? normalizeRect(input.rect, 'selection') : null
  if (kind === 'box' && rect === null) throw new OperationError('Draw a box around the asset to extract', 'no_rect')
  const instruction = [
    `Extract ${ASSET_KINDS[kind]} from this picture and return it on a plain white background, centred, filling the frame.`,
    rect ? `The asset is inside x ${rect.x.toFixed(1)}%, y ${rect.y.toFixed(1)}%, width ${rect.width.toFixed(1)}%, height ${rect.height.toFixed(1)}%.` : '',
    'Show it straight on, evenly lit, with no shadow cast on the background, as a clean catalogue image.',
  ].filter(Boolean).join('\n')
  const inputs = [{ buffer: source.buffer, mediaType: 'image/png' }]
  if (rect) {
    const zoom = await magnify(source.buffer, rect, { minSide: 640, maxSide: 2048 })
    inputs.push({ buffer: zoom.buffer, mediaType: 'image/png' })
  }
  const { image, result } = await renderOne(context, { prompt: instruction, size: input.size, images: inputs })
  const png = await toPng(image.buffer, { maxSide: 4096 })
  const sized = await resizeTo(png.buffer, info.width, info.height)
  return {
    images: [{ buffer: sized, mediaType: 'image/png' }],
    prompt: instruction,
    label: `Extract asset · ${kind}`,
    meta: { kind, rect, usage: result.usage, keyId: result.keyId, trace: result.trace },
  }
}

// ---------------------------------------------------------------------------
// in-image text editing
// ---------------------------------------------------------------------------

const TEXT_VISION = [
  'Split every piece of visible text in this picture into separate editable regions.',
  'For each region give a box as percentages (0-100, origin top-left) and the exact words.',
  'Include signage, labels, posters and overlaid captions; skip text too small to read.',
  'Return strict JSON: {"regions":[{"id":1,"rect":{"x":0,"y":0,"width":0,"height":0},"text":"the words","style":"font style in a few words"}]}',
].join(' ')

/** Recognise the text regions of a picture. Exported because the UI caches this per image. */
export async function recogniseText(input, context) {
  const source = requireSource(input, context)
  const model = requireVisionModel(context, input.visionModel)
  const small = await forVision(source.buffer, context.config.limits?.visionMaxSide ?? 768)
  const plan = await planJson({
    config: context.config,
    model,
    instruction: TEXT_VISION,
    images: [small],
    validate: (parsed) => {
      const rows = Array.isArray(parsed?.regions) ? parsed.regions : []
      const regions = []
      for (const row of rows) {
        let rect
        try { rect = normalizeRect(row?.rect ?? row, 'text region') } catch { continue }
        const text = typeof row?.text === 'string' ? row.text.trim() : ''
        if (text.length === 0) continue
        regions.push({
          id: regions.length + 1,
          rect,
          text: text.slice(0, 500),
          style: typeof row?.style === 'string' ? row.style.slice(0, 200) : '',
        })
      }
      if (regions.length === 0) throw new OperationError('No editable text was found in this picture', 'not_found', 422)
      return { regions: regions.slice(0, 40) }
    },
    signal: context.signal,
    onAttempt: context.onAttempt,
  })
  return { regions: plan.regions, visionModel: model }
}

async function editText(input, context) {
  const source = requireSource(input, context)
  const info = await assertStill(source.buffer)
  let regions = Array.isArray(input.regions) ? input.regions : null
  let visionUsed = ''
  if (regions === null || regions.length === 0) {
    const recognised = await recogniseText(input, context)
    regions = recognised.regions
    visionUsed = recognised.visionModel
  }
  const changes = []
  for (const region of regions) {
    const next = typeof region?.next === 'string' ? region.next.trim() : ''
    const drop = region?.drop === true || (typeof region?.next === 'string' && region.next.length === 0 && region?.drop === true)
    if (drop) changes.push({ region, action: 'clear' })
    else if (next.length > 0 && next !== region.text) changes.push({ region, action: 'replace', text: next })
  }
  if (changes.length === 0) throw new OperationError('Change at least one of the recognised strings', 'no_change')

  const lines = changes.map((row) => row.action === 'clear'
    ? `- Clear the text "${row.region.text}" at x ${row.region.rect.x.toFixed(1)}%, y ${row.region.rect.y.toFixed(1)}%, width ${row.region.rect.width.toFixed(1)}%, height ${row.region.rect.height.toFixed(1)}% and rebuild the surface behind it.`
    : `- Replace the text "${row.region.text}" at x ${row.region.rect.x.toFixed(1)}%, y ${row.region.rect.y.toFixed(1)}%, width ${row.region.rect.width.toFixed(1)}%, height ${row.region.rect.height.toFixed(1)}% with "${row.text}".`)
  const instruction = [
    'Edit the lettering in this picture. Apply exactly these changes:',
    ...lines,
    'Match the original lettering in typeface weight, colour, perspective and lighting so the change looks native.',
    'Leave every other part of the picture unchanged.',
  ].join('\n')

  const generated = await editSource(context, { prompt: instruction, source, size: input.size })
  const sized = await resizeTo(generated.buffer, info.width, info.height)
  const snapshot = regions.map((region) => {
    const change = changes.find((row) => row.region === region || row.region.id === region.id)
    return {
      id: region.id,
      text: change ? (change.action === 'clear' ? '' : change.text) : region.text,
      rect: region.rect,
    }
  })
  return {
    images: [{ buffer: sized, mediaType: 'image/png' }],
    prompt: instruction,
    label: `Edit text · ${changes.length} change${changes.length > 1 ? 's' : ''}`,
    meta: { changes: changes.map((row) => ({ id: row.region.id, from: row.region.text, to: row.action === 'clear' ? '' : row.text })), textSnapshot: snapshot, visionModel: visionUsed, usage: generated.result.usage, keyId: generated.result.keyId, trace: generated.result.trace },
  }
}

// ---------------------------------------------------------------------------
// enhancement, colour and line art
// ---------------------------------------------------------------------------

async function enhance(input, context) {
  const source = requireSource(input, context)
  const info = await assertStill(source.buffer)
  const strength = ['light', 'standard', 'strong'].includes(input.strength) ? input.strength : 'standard'
  const instruction = [
    'Improve this picture without changing its content.',
    strength === 'light'
      ? 'Only clean up compression noise and slight blur; keep the original look.'
      : strength === 'strong'
        ? 'Rebuild fine detail, sharpness and micro-contrast so it looks like a high-resolution capture; keep the composition identical.'
        : 'Restore detail and sharpness, correct the colour balance, and remove noise and compression artefacts.',
    'Do not move, add or remove anything.',
  ].join('\n')
  const generated = await editSource(context, { prompt: instruction, source, size: input.size })
  const sized = await resizeTo(generated.buffer, info.width, info.height)
  return {
    images: [{ buffer: sized, mediaType: 'image/png' }],
    prompt: instruction,
    label: `Enhance · ${strength}`,
    meta: { strength, usage: generated.result.usage, keyId: generated.result.keyId, trace: generated.result.trace },
  }
}

const COLOUR_MODES = {
  mono: { label: 'Colourise', instruction: 'Colourise this monochrome photograph. Choose a restrained, believable palette that suits the period and the light; keep the original tonal structure and every detail.' },
  lineart: { label: 'Colourise line art', instruction: 'Colourise this line drawing. Fill the outlined shapes with flat, harmonious colour, keep the line work crisp and on top, and leave the paper white where it was white.' },
  toLineart: { label: 'Photo to line art', instruction: 'Turn this photograph into clean line art: keep the significant contours and interior detail lines, drop the shading and texture, and put the lines on a plain white background.' },
}

async function colorize(input, context) {
  const source = requireSource(input, context)
  const info = await assertStill(source.buffer)
  const mode = COLOUR_MODES[input.mode] ? input.mode : 'mono'
  const palette = typeof input.palette === 'string' ? input.palette.trim() : ''
  const instruction = [
    COLOUR_MODES[mode].instruction,
    palette.length > 0 ? `Use this palette: ${palette}.` : '',
    'Keep the composition and the framing exactly as they are.',
  ].filter(Boolean).join('\n')
  const extra = []
  if (input.reference?.buffer) {
    const reference = await normalizeForProvider(input.reference.buffer)
    extra.push({ buffer: reference.buffer, mediaType: reference.mediaType })
    instruction += '\nImage 2 is a colour reference; take its palette and mood.'
  }
  const generated = await editSource(context, { prompt: instruction, source, size: input.size, extraImages: extra })
  const sized = await resizeTo(generated.buffer, info.width, info.height)
  return {
    images: [{ buffer: sized, mediaType: 'image/png' }],
    prompt: instruction,
    label: COLOUR_MODES[mode].label,
    meta: { mode, palette, usage: generated.result.usage, keyId: generated.result.keyId, trace: generated.result.trace },
  }
}

// ---------------------------------------------------------------------------
// prompt distillation
// ---------------------------------------------------------------------------

async function distill(input, context) {
  const source = requireSource(input, context)
  const model = requireVisionModel(context, input.visionModel)
  const small = await forVision(source.buffer, context.config.limits?.visionMaxSide ?? 768)
  const plan = await planJson({
    config: context.config,
    model,
    instruction: [
      'Write a single image-generation prompt that would recreate this picture.',
      'Describe subject, composition, camera, lighting, colour and style in one dense paragraph.',
      'Return strict JSON: {"prompt":"the prompt","title":"three to six words"}',
    ].join(' '),
    images: [small],
    validate: (parsed) => {
      const prompt = typeof parsed?.prompt === 'string' ? parsed.prompt.trim() : ''
      if (prompt.length === 0) throw new OperationError('The vision model returned no prompt', 'empty', 422)
      return { prompt: prompt.slice(0, 4000), title: typeof parsed?.title === 'string' ? parsed.title.slice(0, 80) : '' }
    },
    signal: context.signal,
    onAttempt: context.onAttempt,
  })
  return {
    images: [],
    prompt: plan.prompt,
    label: `Prompt distillation${plan.title ? ` · ${plan.title}` : ''}`,
    meta: { title: plan.title, visionModel: model },
  }
}

// ---------------------------------------------------------------------------
// input plumbing
// ---------------------------------------------------------------------------

function requireSource(input, context) {
  if (input.source?.buffer) return input.source
  if (context.source?.buffer) return context.source
  throw new OperationError('This operation needs a picture to work on', 'no_source')
}

function normaliseRects(value, label, options = {}) {
  const rows = Array.isArray(value) ? value : value ? [value] : []
  const out = []
  for (const row of rows) {
    out.push(normalizeRect(row, label))
  }
  if (out.length === 0 && options.optional !== true) {
    throw new OperationError(`Draw a ${label} first`, 'no_rect')
  }
  return out
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

export const OPERATIONS = {
  text2image: { needs: { source: false, vision: false }, run: text2image },
  edit: { needs: { source: true, vision: false }, run: edit },
  localEdit: { needs: { source: true, vision: false }, run: localEdit },
  localEditBatch: { needs: { source: true, vision: false }, run: localEditBatch },
  fusion: { needs: { source: true, vision: true }, run: fusion },
  batchVariables: { needs: { source: false, vision: false }, run: batchVariables },
  batchList: { needs: { source: false, vision: false }, run: batchList },
  outpaint: { needs: { source: true, vision: false }, run: outpaint },
  removeWatermark: { needs: { source: true, vision: true }, run: removeWatermark },
  removeBackground: { needs: { source: true, vision: false }, run: removeBackground },
  removeElement: { needs: { source: true, vision: true }, run: removeElement },
  extractAsset: { needs: { source: true, vision: false }, run: extractAsset },
  editText: { needs: { source: true, vision: true }, run: editText },
  enhance: { needs: { source: true, vision: false }, run: enhance },
  colorize: { needs: { source: true, vision: false }, run: colorize },
  distill: { needs: { source: true, vision: true }, run: distill },
}

/** The operation catalogue, for the UI to build its toolbar from. */
export function operationCatalog() {
  return [
    { id: 'text2image', group: 'create', icon: 'image', needsSource: false, needsVision: false },
    { id: 'edit', group: 'create', icon: 'edit', needsSource: true, needsVision: false },
    { id: 'localEdit', group: 'edit', icon: 'edit', needsSource: true, needsVision: false },
    { id: 'localEditBatch', group: 'edit', icon: 'edit', needsSource: true, needsVision: false },
    { id: 'fusion', group: 'edit', icon: 'sparkle', needsSource: true, needsVision: true },
    { id: 'batchVariables', group: 'batch', icon: 'image', needsSource: false, needsVision: false },
    { id: 'batchList', group: 'batch', icon: 'image', needsSource: false, needsVision: false },
    { id: 'outpaint', group: 'edit', icon: 'expand', needsSource: true, needsVision: false },
    { id: 'removeWatermark', group: 'clean', icon: 'erase', needsSource: true, needsVision: true },
    { id: 'removeBackground', group: 'clean', icon: 'background', needsSource: true, needsVision: false },
    { id: 'removeElement', group: 'clean', icon: 'erase', needsSource: true, needsVision: true },
    { id: 'extractAsset', group: 'extract', icon: 'extract', needsSource: true, needsVision: false },
    { id: 'editText', group: 'edit', icon: 'text', needsSource: true, needsVision: true },
    { id: 'enhance', group: 'edit', icon: 'sparkle', needsSource: true, needsVision: false },
    { id: 'colorize', group: 'edit', icon: 'palette', needsSource: true, needsVision: false },
    { id: 'distill', group: 'create', icon: 'sparkle', needsSource: true, needsVision: true },
  ]
}

export const ELEMENT_PRESET_LIST = Object.entries(ELEMENT_PRESETS).map(([id, row]) => ({ id, label: row.label }))
export const ASSET_KIND_LIST = Object.entries(ASSET_KINDS).map(([id]) => ({ id }))
export const COLOUR_MODE_LIST = Object.entries(COLOUR_MODES).map(([id, row]) => ({ id, label: row.label }))
export const FUSION_MODE_LIST = Object.entries(FUSION_MODES).map(([id]) => ({ id }))

/**
 * Run one operation by name.
 *
 * Unknown names, Raster errors and upstream failures are all translated into
 * OperationError so the HTTP layer has one thing to catch.
 */
export async function runOperation(name, input, context) {
  const entry = OPERATIONS[name]
  if (!entry) throw new OperationError(`Unknown operation "${name}"`, 'unknown_op', 404)
  try {
    return await entry.run(input, context)
  } catch (error) {
    if (error instanceof OperationError) throw error
    if (error instanceof RasterError) throw new OperationError(error.message, error.code, 422)
    if (error instanceof VisionError) throw new OperationError(error.message, error.code, 422)
    if (error instanceof UpstreamError) {
      const wrapped = new OperationError(error.message, error.code ?? 'upstream', error.status >= 400 && error.status < 600 ? error.status : 502)
      wrapped.attempts = error.attempts
      wrapped.trace = error.trace
      throw wrapped
    }
    throw new OperationError(String(error?.message ?? error), 'internal', 500)
  }
}
