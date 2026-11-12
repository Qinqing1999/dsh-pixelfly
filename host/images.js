// dsh-pixelfly — image plumbing.
//
// Turns an upstream response into files on disk, and reads back the tiny header
// facts a settings page wants (dimensions, byte size, format). No image library:
// PNG/JPEG/WebP/GIF headers are a few bytes each.

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { outputDir, readConfig } from './config.js'

const EXT_BY_FORMAT = { png: 'png', jpeg: 'jpg', jpg: 'jpg', webp: 'webp', gif: 'gif' }

export function formatExtension(format) {
  return EXT_BY_FORMAT[String(format || 'png').toLowerCase()] ?? 'png'
}

export function mediaTypeOf(format) {
  const ext = formatExtension(format)
  return ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
}

/** Detect the real container from magic bytes, ignoring what the caller claimed. */
export function sniffImage(bytes) {
  if (!bytes || bytes.length < 12) return null
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    return { format: 'png', mediaType: 'image/png', ext: 'png', width, height }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const size = jpegSize(bytes)
    return { format: 'jpeg', mediaType: 'image/jpeg', ext: 'jpg', width: size?.width ?? 0, height: size?.height ?? 0 }
  }
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const size = webpSize(bytes)
    return { format: 'webp', mediaType: 'image/webp', ext: 'webp', width: size?.width ?? 0, height: size?.height ?? 0 }
  }
  if (bytes.toString('ascii', 0, 3) === 'GIF') {
    return { format: 'gif', mediaType: 'image/gif', ext: 'gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  }
  return null
}

function jpegSize(bytes) {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue }
    const marker = bytes[offset + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
    const length = bytes.readUInt16BE(offset + 2)
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
    offset += 2 + length
  }
  return null
}

function webpSize(bytes) {
  const chunk = bytes.toString('ascii', 12, 16)
  if (chunk === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
  }
  return null
}

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function slug(text, fallback = 'image') {
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return cleaned.length > 0 ? cleaned : fallback
}

/** Write one decoded image to the output directory and return its absolute path. */
export function saveImageBytes(bytes, options = {}) {
  const config = options.config ?? readConfig()
  const dir = outputDir(config)
  fs.mkdirSync(dir, { recursive: true })
  const sniff = sniffImage(bytes)
  const ext = sniff?.ext ?? formatExtension(options.format)
  const base = `${stamp()}-${slug(options.prompt)}-${randomBytes(3).toString('hex')}`
  const target = path.join(dir, `${base}.${ext}`)
  fs.writeFileSync(target, bytes, { mode: 0o644 })
  return { path: target, dir, ...(sniff ?? { format: ext, mediaType: mediaTypeOf(ext), width: 0, height: 0 }), bytes: bytes.length }
}

/** Keep the newest N files in the output directory, deleting the oldest beyond that. */
export function pruneOutput(config = readConfig()) {
  const keep = Math.max(0, Math.round(config.output?.keepFiles ?? 200))
  if (keep === 0) return { removed: 0, kept: 0 }
  const dir = outputDir(config)
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(entry.name))
      .map((entry) => {
        const full = path.join(dir, entry.name)
        let stat = null
        try { stat = fs.statSync(full) } catch { stat = null }
        return { full, mtimeMs: stat?.mtimeMs ?? 0 }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    return { removed: 0, kept: 0 }
  }
  const doomed = entries.slice(keep)
  let removed = 0
  for (const entry of doomed) {
    try { fs.unlinkSync(entry.full); removed += 1 } catch { /* ignore */ }
  }
  return { removed, kept: Math.min(entries.length, keep) }
}

/** Read a previously generated file back for the studio page thumbnail. */
export function readGeneratedFile(candidate) {
  const dir = outputDir(readConfig())
  const resolved = path.resolve(String(candidate || ''))
  const relative = path.relative(dir, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  try {
    const stat = fs.statSync(resolved)
    if (!stat.isFile() || stat.size > 40 * 1024 * 1024) return null
    const bytes = fs.readFileSync(resolved)
    const sniff = sniffImage(bytes)
    return { bytes, stat, sniff, path: resolved, name: path.basename(resolved) }
  } catch {
    return null
  }
}

/** The most recent generated images, newest first. */
export function listGenerated(limit = 24) {
  const dir = outputDir(readConfig())
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(entry.name))
      .map((entry) => {
        const full = path.join(dir, entry.name)
        let stat = null
        try { stat = fs.statSync(full) } catch { stat = null }
        return { name: entry.name, path: full, bytes: stat?.size ?? 0, mtimeMs: stat?.mtimeMs ?? 0 }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, Math.max(1, Math.min(200, limit)))
  } catch {
    return []
  }
  return entries
}

/** Decode the upstream's response into a list of image buffers. */
export function imagesFromPayload(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : []
  const out = []
  for (const row of rows) {
    if (typeof row?.b64_json === 'string' && row.b64_json.length > 0) {
      out.push({ bytes: Buffer.from(row.b64_json, 'base64'), kind: 'b64' })
    } else if (typeof row?.url === 'string' && /^https?:/i.test(row.url)) {
      out.push({ url: row.url, kind: 'url' })
    }
  }
  return out
}

/** Fetch a URL the upstream returned instead of inline bytes. */
export async function downloadImage(url, signal) {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) throw new Error('cancelled')
    signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), 60000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`image download answered HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}
