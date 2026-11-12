// dsh-pixelfly — raster primitives.
//
// Everything that touches pixels lives here so the operation layer never has to
// know about encoders. Three jobs:
//
//   * decode/encode helpers with one consistent error shape,
//   * geometry: picking a supported canvas for a source image, and pasting a
//     generated region back into original pixels,
//   * validation: proving a "transparent background" result really is transparent
//     and still has a visible subject, instead of trusting the model.
//
// The paste-back helpers are the reason local edits can promise that pixels
// outside the selection are untouched: the model's answer is only ever read
// inside the selection, and the original bytes are kept everywhere else.

import sharp from 'sharp'

const DECODE = { limitInputPixels: 40_000_000, failOn: 'error' }

export class RasterError extends Error {
  constructor(message, code = 'raster') {
    super(message)
    this.name = 'RasterError'
    this.code = code
  }
}

/** Accepts the three still formats every operation can round-trip. */
export const STILL_FORMATS = ['png', 'jpeg', 'webp']

export function mediaTypeFor(format) {
  if (format === 'jpeg' || format === 'jpg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  if (format === 'gif') return 'image/gif'
  return 'image/png'
}

export function extensionFor(format) {
  if (format === 'jpeg' || format === 'jpg') return 'jpg'
  if (format === 'webp') return 'webp'
  if (format === 'gif') return 'gif'
  return 'png'
}

/** Read the format and dimensions without decoding every pixel. */
export async function probe(bytes) {
  try {
    const meta = await sharp(bytes, DECODE).metadata()
    const width = meta.autoOrient?.width ?? meta.width
    const height = meta.autoOrient?.height ?? meta.height
    return {
      format: meta.format ?? 'png',
      width: width ?? 0,
      height: height ?? 0,
      pages: meta.pages ?? 1,
      hasAlpha: Boolean(meta.hasAlpha),
    }
  } catch (error) {
    throw new RasterError(`Cannot read image: ${error.message}`, 'raster.decode')
  }
}

/** Assert the bytes are a single-frame still image we can edit. */
export async function assertStill(bytes, label = 'image') {
  const info = await probe(bytes)
  if (!STILL_FORMATS.includes(info.format)) {
    throw new RasterError(`${label} must be a PNG, JPEG or WebP still image`, 'raster.format')
  }
  if (info.pages > 1) {
    throw new RasterError(`${label} must be a single frame`, 'raster.animated')
  }
  if (info.width < 2 || info.height < 2) {
    throw new RasterError(`${label} has no usable pixels`, 'raster.empty')
  }
  return info
}

/**
 * Decode to straight sRGB PNG with EXIF orientation applied.
 *
 * Every coordinate the user gives us (a selection, a click, a crop box) is
 * expressed against what they see on screen, so orientation has to be baked in
 * before any of that arithmetic happens.
 */
export async function toPng(bytes, { maxSide = 4096 } = {}) {
  await assertStill(bytes)
  const pipeline = sharp(bytes, DECODE).autoOrient().toColourspace('srgb')
  const scaled = maxSide > 0 ? pipeline.resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true }) : pipeline
  const { data, info } = await scaled.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
  return { buffer: data, mediaType: 'image/png', width: info.width, height: info.height }
}

/** Decode to a raw RGBA buffer, the form the paste-back maths needs. */
export async function toRgba(bytes, width, height) {
  const pipeline = sharp(bytes, DECODE).autoOrient().toColourspace('srgb')
  const sized = width && height ? pipeline.resize(width, height, { fit: 'fill' }) : pipeline
  return sized.ensureAlpha().raw().toBuffer()
}

// --- geometry ------------------------------------------------------------------

/**
 * A rect is a percentage box in 0..100 so it survives any resize of the source.
 * Anything a vision model returns is validated through here before it is trusted.
 */
export function normalizeRect(value, label = 'selection') {
  const keys = ['x', 'y', 'width', 'height']
  if (!value || keys.some((key) => typeof value[key] !== 'number' || !Number.isFinite(value[key]))) {
    throw new RasterError(`${label} needs numeric x, y, width and height`, 'raster.rect')
  }
  const { x, y } = value
  const width = value.width
  const height = value.height
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x >= 100 || y >= 100) {
    throw new RasterError(`${label} must sit inside the image (0-100%)`, 'raster.rect')
  }
  return {
    x,
    y,
    width: Math.min(width, 100 - x),
    height: Math.min(height, 100 - y),
  }
}

/** Percentage rect to integer pixels, clamped to the image. */
export function toPixels(rect, width, height) {
  const left = Math.max(0, Math.min(width - 1, Math.floor((rect.x * width) / 100)))
  const top = Math.max(0, Math.min(height - 1, Math.floor((rect.y * height) / 100)))
  const right = Math.min(width, Math.ceil(((rect.x + rect.width) * width) / 100))
  const bottom = Math.min(height, Math.ceil(((rect.y + rect.height) * height) / 100))
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
}

/** True when two rects overlap enough that one can be said to cover the other. */
export function rectsOverlap(a, b, threshold = 0.8) {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= x || bottom <= y) return false
  return (right - x) * (bottom - y) >= b.width * b.height * threshold
}

/** Aspect ratio as a "w:h" string with the common divisor removed. */
export function aspectRatio(width, height) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a)
  const divisor = gcd(width, height) || 1
  return `${width / divisor}:${height / divisor}`
}

/** The supported canvas whose aspect ratio is closest to the source. */
export function closestSize(width, height, sizes) {
  const options = (Array.isArray(sizes) ? sizes : []).filter((size) => /^\d{2,4}x\d{2,4}$/.test(String(size)))
  if (options.length === 0) return 'auto'
  const target = width / height
  let best = options[0]
  let bestScore = Number.POSITIVE_INFINITY
  for (const size of options) {
    const [w, h] = String(size).split('x').map(Number)
    // Compare in log space so 2:1 and 1:2 are penalised equally.
    const score = Math.abs(Math.log(w / h) - Math.log(target))
    if (score < bestScore) {
      bestScore = score
      best = size
    }
  }
  return best
}

// --- canvas normalisation ------------------------------------------------------

const MIN_SIDE = 512
const MAX_SIDE = 4096
const SIDE_STEP = 32
const MAX_RATIO = 3
const MAX_INPUT_BYTES = 10 * 1024 * 1024

const roundUp = (value, step) => Math.ceil(value / step) * step

/**
 * Fit an image onto a canvas some providers will accept.
 *
 * Image models frequently reject reference inputs below a minimum side, above a
 * maximum side, off a fixed pixel grid, or past a ratio limit. Rather than crop
 * (which would silently change the composition), the content is scaled down and
 * centred, and the remainder is filled by repeating the edge pixels.
 */
export function fitCanvas(width, height, preferred) {
  const match = String(preferred ?? '').match(/^(\d{3,4})x(\d{3,4})$/)
  if (match) {
    const w = Number(match[1])
    const h = Number(match[2])
    const ratio = w / h
    if (
      w >= MIN_SIDE && h >= MIN_SIDE && w <= MAX_SIDE && h <= MAX_SIDE &&
      w % SIDE_STEP === 0 && h % SIDE_STEP === 0 &&
      ratio <= MAX_RATIO && ratio >= 1 / MAX_RATIO
    ) {
      return { width: w, height: h }
    }
  }
  const shrink = Math.min(1, MAX_SIDE / Math.max(width, height))
  let contentWidth = Math.max(1, Math.round(width * shrink))
  let contentHeight = Math.max(1, Math.round(height * shrink))
  const grow = Math.max(MIN_SIDE / contentWidth, MIN_SIDE / contentHeight, 1)
  if (contentWidth * grow <= MAX_SIDE && contentHeight * grow <= MAX_SIDE) {
    contentWidth = Math.max(1, Math.round(contentWidth * grow))
    contentHeight = Math.max(1, Math.round(contentHeight * grow))
  }
  let canvasWidth = Math.max(MIN_SIDE, roundUp(contentWidth, SIDE_STEP))
  let canvasHeight = Math.max(MIN_SIDE, roundUp(contentHeight, SIDE_STEP))
  if (canvasWidth / canvasHeight > MAX_RATIO) canvasHeight = roundUp(canvasWidth / MAX_RATIO, SIDE_STEP)
  if (canvasHeight / canvasWidth > MAX_RATIO) canvasWidth = roundUp(canvasHeight / MAX_RATIO, SIDE_STEP)
  return { width: Math.min(MAX_SIDE, canvasWidth), height: Math.min(MAX_SIDE, canvasHeight) }
}

/**
 * Re-encode an image onto a provider-safe canvas without touching the original.
 *
 * The caller keeps the source bytes; this only builds the copy that goes on the
 * wire. PNG is preferred (lossless, and transparency survives); a JPEG fallback
 * exists because a large photographic reference can otherwise exceed the input
 * ceiling.
 */
export async function normalizeForProvider(bytes, preferred) {
  const info = await assertStill(bytes)
  const canvas = fitCanvas(info.width, info.height, preferred)
  const scale = Math.min(canvas.width / info.width, canvas.height / info.height)
  const innerWidth = Math.max(1, Math.min(canvas.width, Math.round(info.width * scale)))
  const innerHeight = Math.max(1, Math.min(canvas.height, Math.round(info.height * scale)))
  const left = Math.floor((canvas.width - innerWidth) / 2)
  const top = Math.floor((canvas.height - innerHeight) / 2)
  const padded = sharp(bytes, DECODE).autoOrient().toColourspace('srgb')
    .resize(innerWidth, innerHeight, { fit: 'fill' })
    .extend({
      left,
      right: canvas.width - innerWidth - left,
      top,
      bottom: canvas.height - innerHeight - top,
      extendWith: 'copy',
    })
  const png = await padded.clone().png({ compressionLevel: 9 }).toBuffer()
  if (png.length <= MAX_INPUT_BYTES) {
    return { buffer: png, mediaType: 'image/png', width: canvas.width, height: canvas.height }
  }
  const jpeg = await padded.clone().flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true }).toBuffer()
  if (jpeg.length > MAX_INPUT_BYTES) {
    throw new RasterError('The reference image is still over 10MB after resizing; scale it down first', 'raster.tooLarge')
  }
  return { buffer: jpeg, mediaType: 'image/jpeg', width: canvas.width, height: canvas.height }
}

/** A magnified crop, used to give a vision model a closer look at a selection. */
export async function magnify(bytes, rect, { minSide = 512, maxSide = 2048 } = {}) {
  const info = await assertStill(bytes)
  const region = toPixels(rect, info.width, info.height)
  const shortest = Math.max(1, Math.min(region.width, region.height))
  const longest = Math.max(1, Math.max(region.width, region.height))
  const scale = Math.max(1, Math.min(4, minSide / shortest, maxSide / longest))
  const width = Math.max(1, Math.round(region.width * scale))
  const height = Math.max(1, Math.round(region.height * scale))
  const buffer = await sharp(bytes, DECODE).autoOrient()
    .extract(region)
    .resize(width, height, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer()
  return { buffer, mediaType: 'image/png', width, height }
}

/**
 * Crop the selection together with a margin of real picture around it.
 *
 * Sending the whole frame and asking the model to touch one box makes it paint that
 * box as an isolated picture: it has no reason to continue the wall behind it, so the
 * patch arrives with its own backdrop and the join shows. Sending a padded crop puts
 * genuine surrounding pixels right against the edge of the area to change, and models
 * continue what they can see. The returned `inner` is where the selection sits inside
 * the crop, so the answer can be trimmed back to exactly that part.
 */
export async function cropWithMargin(bytes, rect, { margin = 0.35, minSide = 512, maxSide = 2048 } = {}) {
  const info = await assertStill(bytes)
  const region = toPixels(rect, info.width, info.height)
  const padX = Math.round(region.width * margin)
  const padY = Math.round(region.height * margin)
  const left = Math.max(0, region.left - padX)
  const top = Math.max(0, region.top - padY)
  const right = Math.min(info.width, region.left + region.width + padX)
  const bottom = Math.min(info.height, region.top + region.height + padY)
  const cropWidth = right - left
  const cropHeight = bottom - top
  const shortest = Math.max(1, Math.min(cropWidth, cropHeight))
  const longest = Math.max(1, Math.max(cropWidth, cropHeight))
  const scale = Math.max(1, Math.min(4, minSide / shortest, maxSide / longest))
  const width = Math.max(1, Math.round(cropWidth * scale))
  const height = Math.max(1, Math.round(cropHeight * scale))
  const buffer = await sharp(bytes, DECODE).autoOrient()
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .resize(width, height, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer()
  return {
    buffer,
    mediaType: 'image/png',
    width,
    height,
    scale,
    inner: {
      left: Math.round((region.left - left) * scale),
      top: Math.round((region.top - top) * scale),
      width: Math.max(1, Math.round(region.width * scale)),
      height: Math.max(1, Math.round(region.height * scale)),
    },
  }
}

/** Cut one pixel box out of a picture, keeping its bytes as a PNG. */
export async function extractPixels(bytes, box) {
  const info = await assertStill(bytes)
  const left = Math.max(0, Math.min(info.width - 1, Math.round(box.left)))
  const top = Math.max(0, Math.min(info.height - 1, Math.round(box.top)))
  const width = Math.max(1, Math.min(info.width - left, Math.round(box.width)))
  const height = Math.max(1, Math.min(info.height - top, Math.round(box.height)))
  const buffer = await sharp(bytes, DECODE).autoOrient()
    .extract({ left, top, width, height })
    .png()
    .toBuffer()
  return { buffer, mediaType: 'image/png', width, height }
}

/**
 * Put a patch into a full frame at the region, then hand the result to the blender.
 *
 * The model answers about a crop, not the whole picture, so its answer has to be
 * scaled to the region's pixel size and placed before the usual feathered paste can
 * do its work.
 */
export async function overlayRegion(sourceBytes, patchBytes, rect) {
  const info = await assertStill(sourceBytes)
  const { width, height } = info
  const region = toPixels(rect, width, height)
  const patch = await sharp(patchBytes, DECODE).autoOrient()
    .resize(region.width, region.height, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .png()
    .toBuffer()
  const base = await sharp(sourceBytes, DECODE).autoOrient().ensureAlpha().png().toBuffer()
  return sharp(base)
    .composite([{ input: patch, left: region.left, top: region.top }])
    .png()
    .toBuffer()
}

/** Crop the selection together with a margin of real picture around it.
// --- paste back ------------------------------------------------------------------

/** Fractional coverage (0..1) of a pixel at (x, y) inside a region, feathered at the edge. */
/**
 * How opaque the generated pixels are this far into the region.
 *
 * A linear ramp leaves a visible crease because the slope changes abruptly at both
 * ends; smoothstep eases in and out, which reads as a gradient rather than a cut.
 */
function edgeWeight(x, y, width, height, feather) {
  const distance = Math.min(x, y, width - 1 - x, height - 1 - y)
  if (distance >= feather) return 1
  const t = (distance + 1) / feather
  return t * t * (3 - 2 * t)
}

/**
 * The fade band, in pixels.
 *
 * It has to scale with the region: a 40px patch needs a couple of pixels, while a
 * 400px repaint needs tens, otherwise the seam stays sharp on big edits. The cap
 * keeps a full-frame edit from washing out its own subject.
 */
function featherFor(region) {
  const short = Math.min(region.width, region.height)
  // Two failure modes bracket this number. A narrow band reads as a hard box, because
  // the eye locks onto where the new content suddenly stops. A wide one turns the new
  // subject translucent, because the ramp then covers most of the patch. A tenth of
  // the short side, capped, keeps the subject solid and still hides the outline.
  return Math.max(8, Math.min(96, Math.round(short * 0.16)))
}

/**
 * Shift the generated patch so its border agrees with the picture around it.
 *
 * The model paints a region from scratch, so it usually invents its own backdrop
 * and lighting; pasting that in leaves a visible halo even with a soft edge. The
 * fix is the cheap half of a Poisson blend: compare the mean colour just outside
 * the region with the mean colour just inside the generated patch, then push the
 * patch by that difference, decaying inward so the middle keeps the model's work.
 */
function matchSeamColors(original, generated, region, width, height, band) {
  const outer = [0, 0, 0, 0]
  let outerCount = 0
  const inner = [0, 0, 0, 0]
  let innerCount = 0
  for (let y = -band; y < region.height + band; y += 1) {
    for (let x = -band; x < region.width + band; x += 1) {
      const px = region.left + x
      const py = region.top + y
      if (px < 0 || py < 0 || px >= width || py >= height) continue
      const offset = (py * width + px) * 4
      const inside = x >= 0 && y >= 0 && x < region.width && y < region.height
      // The ring is everything the patch will not overwrite; the inner sample is
      // the outermost few pixels of the patch, which is what has to line up.
      if (!inside) {
        for (let channel = 0; channel < 3; channel += 1) outer[channel] += original[offset + channel]
        outerCount += 1
      } else if (x < band || y < band || x >= region.width - band || y >= region.height - band) {
        for (let channel = 0; channel < 3; channel += 1) inner[channel] += generated[offset + channel]
        innerCount += 1
      }
    }
  }
  if (outerCount === 0 || innerCount === 0) return [0, 0, 0]
  const delta = [0, 0, 0]
  for (let channel = 0; channel < 3; channel += 1) {
    delta[channel] = Math.round(outer[channel] / outerCount - inner[channel] / innerCount)
  }
  // A huge correction means the model drew something unrelated; clamping keeps a
  // wrong patch from smearing its tint across the whole selection.
  const limit = 48
  for (let channel = 0; channel < 3; channel += 1) {
    delta[channel] = Math.max(-limit, Math.min(limit, delta[channel]))
  }
  return delta
}

/**
 * How much the model changed the pixels outside the region it was asked to edit.
 *
 * This decides whether a local edit can simply be returned as-is. When the model
 * obeys "leave the rest alone", its full frame already has a seamless join and
 * pasting a box into the old picture can only make things worse. When it repaints
 * the whole scene, the outside area moves a lot and the paste is the safer answer.
 */
/**
 * The mean colour gap across the region border, in 0..255 per channel.
 *
 * This is the number that decides whether a generated frame can stand on its own.
 * A faithful edit continues the surrounding picture, so the colour just inside the
 * region is close to the colour just outside it. A patch painted on its own backdrop
 * shows a large gap even when every pixel outside the region was left untouched —
 * which is exactly the case a pure "did it move the outside?" check misses.
 */
export async function seamGap(sourceBytes, generatedBytes, rect, band = 6) {
  const info = await assertStill(sourceBytes)
  const { width, height } = info
  const region = toPixels(rect, width, height)
  const original = await toRgba(sourceBytes, width, height)
  const generated = await toRgba(generatedBytes, width, height)
  const outer = [0, 0, 0]
  let outerCount = 0
  const inner = [0, 0, 0]
  let innerCount = 0
  for (let y = -band; y < region.height + band; y += 1) {
    for (let x = -band; x < region.width + band; x += 1) {
      const px = region.left + x
      const py = region.top + y
      if (px < 0 || py < 0 || px >= width || py >= height) continue
      const offset = (py * width + px) * 4
      const inside = x >= 0 && y >= 0 && x < region.width && y < region.height
      if (!inside) {
        for (let channel = 0; channel < 3; channel += 1) outer[channel] += original[offset + channel]
        outerCount += 1
      } else if (x < band || y < band || x >= region.width - band || y >= region.height - band) {
        for (let channel = 0; channel < 3; channel += 1) inner[channel] += generated[offset + channel]
        innerCount += 1
      }
    }
  }
  if (outerCount === 0 || innerCount === 0) return 255
  let gap = 0
  for (let channel = 0; channel < 3; channel += 1) {
    gap += Math.abs(outer[channel] / outerCount - inner[channel] / innerCount)
  }
  return gap / 3
}

export async function changedOutsideRatio(sourceBytes, generatedBytes, rect, threshold = 18) {
  const info = await assertStill(sourceBytes)
  const { width, height } = info
  const region = toPixels(rect, width, height)
  const original = await toRgba(sourceBytes, width, height)
  const generated = await toRgba(generatedBytes, width, height)
  let changed = 0
  let total = 0
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const inside = x >= region.left && y >= region.top && x < region.left + region.width && y < region.top + region.height
      if (inside) continue
      const offset = (y * width + x) * 4
      const delta = Math.abs(original[offset] - generated[offset])
        + Math.abs(original[offset + 1] - generated[offset + 1])
        + Math.abs(original[offset + 2] - generated[offset + 2])
      if (delta > threshold * 3) changed += 1
      total += 1
    }
  }
  return total === 0 ? 0 : changed / total
}

/**
 * Copy only the generated region into the original pixels.
 *
 * The output is resized back to the source size, then blended inward over a few
 * pixels at the region edge so the seam is not a hard line. Everything outside
 * the region keeps its original bytes exactly — that is the promise a local edit
 * makes, and it is the reason this exists instead of just returning the model's
 * full-frame answer.
 */
export async function pasteRegion(sourceBytes, generatedBytes, rect) {
  const info = await assertStill(sourceBytes)
  const { width, height } = info
  const region = toPixels(rect, width, height)
  const original = await toRgba(sourceBytes, width, height)
  const generated = await toRgba(generatedBytes, width, height)
  const feather = featherFor(region)
  const delta = matchSeamColors(original, generated, region, width, height, Math.max(2, Math.round(feather * 0.6)))
  for (let y = 0; y < region.height; y += 1) {
    for (let x = 0; x < region.width; x += 1) {
      const weight = edgeWeight(x, y, region.width, region.height, feather)
      // The colour correction applies across the whole patch, not just at its border.
      // The model re-lights whatever it repaints, so the inside arrives with its own
      // cast; correcting only the rim leaves a lighter block sitting in a darker
      // picture. Shifting everything by the border difference makes the patch belong
      // to the same scene, and the blend below still hides the outline.
      const offset = ((region.top + y) * width + region.left + x) * 4
      for (let channel = 0; channel < 3; channel += 1) {
        const shifted = generated[offset + channel] + delta[channel]
        original[offset + channel] = Math.round(
          original[offset + channel] * (1 - weight) + Math.max(0, Math.min(255, shifted)) * weight,
        )
      }
      original[offset + 3] = Math.round(original[offset + 3] * (1 - weight) + generated[offset + 3] * weight)
    }
  }
  const buffer = await sharp(original, { raw: { width, height, channels: 4 } }).png().toBuffer()
  return { buffer, mediaType: 'image/png', width, height }
}

/**
 * The same paste, for an operation that touched several disjoint regions.
 *
 * Overlapping boxes are unioned with a max rather than blended twice (a double
 * blend would darken the overlap), and protected boxes are zeroed afterwards so
 * a subject the user asked to keep always wins over a removal box.
 */
export async function pasteRegions(sourceBytes, generatedBytes, rects, protectedRects = []) {
  const info = await assertStill(sourceBytes)
  const { width, height } = info
  const original = await toRgba(sourceBytes, width, height)
  const generated = await toRgba(generatedBytes, width, height)
  const weights = new Uint8Array(width * height)
  for (const rect of rects) {
    const region = toPixels(rect, width, height)
    const feather = featherFor(region)
    for (let y = 0; y < region.height; y += 1) {
      for (let x = 0; x < region.width; x += 1) {
        const value = Math.round(255 * edgeWeight(x, y, region.width, region.height, feather))
        const index = (region.top + y) * width + region.left + x
        if (value > weights[index]) weights[index] = value
      }
    }
  }
  for (const rect of protectedRects) {
    const region = toPixels(rect, width, height)
    for (let y = 0; y < region.height; y += 1) {
      const start = (region.top + y) * width + region.left
      weights.fill(0, start, start + region.width)
    }
  }
  for (let index = 0; index < weights.length; index += 1) {
    const weight = weights[index] / 255
    if (weight === 0) continue
    const offset = index * 4
    for (let channel = 0; channel < 4; channel += 1) {
      original[offset + channel] = Math.round(
        original[offset + channel] * (1 - weight) + generated[offset + channel] * weight,
      )
    }
  }
  const buffer = await sharp(original, { raw: { width, height, channels: 4 } }).png().toBuffer()
  return { buffer, mediaType: 'image/png', width, height }
}

/** Grow the canvas around an image, filling the new area by mirroring the edge. */
export async function extendCanvas(bytes, { width, height, left = 0, top = 0 }) {
  const info = await assertStill(bytes)
  const targetWidth = Math.max(info.width, Math.round(width))
  const targetHeight = Math.max(info.height, Math.round(height))
  const offsetX = Math.max(0, Math.min(targetWidth - info.width, Math.round(left)))
  const offsetY = Math.max(0, Math.min(targetHeight - info.height, Math.round(top)))
  const buffer = await sharp(bytes, DECODE).autoOrient().toColourspace('srgb')
    .extend({
      left: offsetX,
      right: targetWidth - info.width - offsetX,
      top: offsetY,
      bottom: targetHeight - info.height - offsetY,
      extendWith: 'mirror',
    })
    .png()
    .toBuffer()
  return { buffer, mediaType: 'image/png', width: targetWidth, height: targetHeight }
}

// --- validation ------------------------------------------------------------------

/**
 * Measure how much of an image is see-through, and how much of what remains is
 * actually visible.
 *
 * A background-removal model that gives up tends to answer with either an
 * untouched opaque image or a fully empty canvas. Both are technically valid
 * PNGs, so the result is rejected here instead of being handed back as success.
 */
export async function transparencyReport(bytes) {
  const info = await assertStill(bytes)
  const raw = await toRgba(bytes, info.width, info.height)
  const pixels = info.width * info.height
  let transparent = 0
  let visible = 0
  for (let index = 3; index < raw.length; index += 4) {
    if (raw[index] < 250) transparent += 1
    if (raw[index] > 5) visible += 1
  }
  return {
    pixels,
    transparentRatio: transparent / pixels,
    visibleRatio: visible / pixels,
  }
}

/**
 * Cut a subject out of its backdrop without asking a model to do it.
 *
 * Models routinely answer "transparent background" with an opaque picture, and a
 * flat studio backdrop is the common case for the pictures this plugin makes.
 * Flood-filling the border colour inward recovers a real cutout for those, and
 * reports how much it removed so the caller can tell whether it worked.
 */
export async function cutoutByFloodFill(bytes, { tolerance = 26, maxRatio = 0.98 } = {}) {
  const info = await assertStill(bytes)
  const width = info.width
  const height = info.height
  const raw = await toRgba(bytes, width, height)
  const pixels = width * height
  const seeds = []
  for (let x = 0; x < width; x += 1) {
    seeds.push(x, (height - 1) * width + x)
  }
  for (let y = 0; y < height; y += 1) {
    seeds.push(y * width, y * width + width - 1)
  }
  const visited = new Uint8Array(pixels)
  const stack = []
  for (const seed of seeds) {
    if (seed >= 0 && seed < pixels && visited[seed] === 0) {
      visited[seed] = 1
      stack.push(seed)
    }
  }
  // The backdrop colour is the average of the border ring, which is what the
  // fill has to match; sampling per-pixel would leak through gradients.
  let rSum = 0
  let gSum = 0
  let bSum = 0
  for (const seed of seeds) {
    rSum += raw[seed * 4]
    gSum += raw[seed * 4 + 1]
    bSum += raw[seed * 4 + 2]
  }
  const count = seeds.length || 1
  const base = [rSum / count, gSum / count, bSum / count]
  const limit = tolerance * tolerance * 3
  let cleared = 0
  while (stack.length > 0) {
    const index = stack.pop()
    const offset = index * 4
    const dr = raw[offset] - base[0]
    const dg = raw[offset + 1] - base[1]
    const db = raw[offset + 2] - base[2]
    if (dr * dr + dg * dg + db * db > limit) continue
    raw[offset + 3] = 0
    cleared += 1
    if (cleared / pixels > maxRatio) break
    const x = index % width
    const y = (index - x) / width
    if (x > 0 && visited[index - 1] === 0) { visited[index - 1] = 1; stack.push(index - 1) }
    if (x + 1 < width && visited[index + 1] === 0) { visited[index + 1] = 1; stack.push(index + 1) }
    if (y > 0 && visited[index - width] === 0) { visited[index - width] = 1; stack.push(index - width) }
    if (y + 1 < height && visited[index + width] === 0) { visited[index + width] = 1; stack.push(index + width) }
  }
  const buffer = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer()
  return { buffer, mediaType: 'image/png', width, height, clearedRatio: cleared / pixels, backdrop: base.map((v) => Math.round(v)) }
}

/** Re-encode to PNG with a transparent-capable alpha channel. */
export async function toTransparentPng(bytes) {
  const info = await assertStill(bytes)
  const buffer = await sharp(bytes, DECODE).autoOrient().toColourspace('srgb').ensureAlpha().png().toBuffer()
  return { buffer, mediaType: 'image/png', width: info.width, height: info.height }
}

/** Check the generated frame has the source's exact pixel size. */
export async function assertDimensions(bytes, width, height, label = 'result') {
  const info = await probe(bytes)
  if (info.width !== width || info.height !== height) {
    throw new RasterError(`${label} came back ${info.width}x${info.height}, expected ${width}x${height}`, 'raster.size')
  }
  return info
}

/** Encode a raw RGBA buffer back to PNG. */
export async function fromRgba(data, width, height) {
  const buffer = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer()
  return { buffer, mediaType: 'image/png', width, height }
}
