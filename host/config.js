// dsh-pixelfly — configuration store.
//
// Everything the plugin can be told lives in one JSON file under the Harness data
// directory, so the settings page, the tools and the studio all read the same
// truth. The file is written atomically (temp file + rename) with mode 0600
// because it holds API keys.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_HOME = path.join(os.homedir(), '.dsh')

/** Root of the Harness data directory, honouring DSH_HOME. */
export function dataRoot() {
  const override = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return override.length > 0 ? path.resolve(override) : DEFAULT_HOME
}

/** This plugin's private directory (config, state, history, generated files). */
export function pluginRoot() {
  return path.join(dataRoot(), 'plugins-data', 'pixelfly')
}

export function configPath() {
  return path.join(pluginRoot(), 'config.json')
}

export function workspaceRoot() {
  return path.join(pluginRoot(), 'history')
}

/**
 * The sizes an upstream is willing to produce.
 *
 * A model that edits an existing picture is asked for `size: 'auto'` and answers
 * on a canvas of its own choosing, so the requested size only matters for
 * text-to-image and for outpainting.
 */
export const SENSENOVA_SIZES = [
  '1024x1024', '1664x2496', '2496x1664', '1760x2368', '2368x1760',
  '1824x2272', '2272x1824', '2048x2048', '2752x1536', '1536x2752',
  '3072x1376', '1344x3136',
]

export const OPENAI_SIZES = ['1024x1024', '1536x1024', '1024x1536']

export const DEFAULT_CONFIG = {
  version: 2,
  upstream: {
    baseUrl: 'https://token.sensenova.cn/v1',
    provider: 'sensenova',
    imagesPath: '/images/generations',
    modelsPath: '/models',
    // How the vision model is spoken to: `chat` (chat completions, the common
    // case), `anthropic` (a /messages endpoint) or `responses` (the Responses API).
    visionFormat: 'chat',
    timeoutMs: 180000,
    visionTimeoutMs: 90000,
  },
  apiKeys: [],
  models: {
    default: 'sensenova-u1.5-fast',
    items: [
      { id: 'sensenova-u1.5-fast', label: 'SenseNova U1.5 Fast' },
      { id: 'sensenova-u1.5-lite', label: 'SenseNova U1.5 Lite' },
    ],
    visionDefault: 'sensenova-6.8-flash',
    visionItems: [
      { id: 'sensenova-6.8-flash', label: 'SenseNova 6.8 Flash' },
      { id: 'sensenova-6.8-flash-lite', label: 'SenseNova 6.8 Flash Lite' },
    ],
  },
  retry: {
    maxAttempts: 4,
    baseDelayMs: 700,
    maxDelayMs: 20000,
    jitter: 0.25,
    rotateKeys: true,
    retryOn: [408, 409, 425, 429, 500, 502, 503, 504],
    cooldownMs: 60000,
    respectRetryAfter: true,
  },
  request: {
    n: 1,
    size: '1024x1024',
    watermark: false,
    promptExtend: true,
    responseFormat: 'b64_json',
    outputFormat: 'png',
  },
  limits: {
    maxBatch: 50,
    maxUploadBytes: 12582912,
    maxPromptChars: 12000,
    visionMaxSide: 768,
  },
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function mergeDeep(base, patch) {
  if (patch === undefined || patch === null) return clone(base)
  if (Array.isArray(patch)) return clone(patch)
  if (typeof patch !== 'object') return patch
  const out = clone(base && typeof base === 'object' && !Array.isArray(base) ? base : {})
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (Array.isArray(value)) out[key] = clone(value)
    else if (value !== null && typeof value === 'object' && out[key] !== null && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergeDeep(out[key], value)
    } else {
      out[key] = clone(value)
    }
  }
  return out
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeFileAtomic(target, text, mode = 0o600) {
  ensureDir(path.dirname(target))
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, text, { mode })
  try { fs.chmodSync(temp, mode) } catch { /* Windows ignores POSIX modes */ }
  fs.renameSync(temp, target)
  return target
}

let cache = null
let cacheMtime = 0

/** Read the merged configuration. Missing keys fall back to defaults. */
export function readConfig() {
  let stat = null
  try { stat = fs.statSync(configPath()) } catch { stat = null }
  if (cache !== null && stat !== null && stat.mtimeMs === cacheMtime) return clone(cache)
  let stored = {}
  if (stat !== null) {
    try {
      stored = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    } catch {
      stored = {}
    }
  }
  const merged = mergeDeep(DEFAULT_CONFIG, stored)
  if (!Array.isArray(merged.apiKeys)) merged.apiKeys = []
  merged.apiKeys = merged.apiKeys.filter((entry) => entry && typeof entry === 'object')
  if (!Array.isArray(merged.models?.items) || merged.models.items.length === 0) {
    merged.models.items = clone(DEFAULT_CONFIG.models.items)
  }
  if (!Array.isArray(merged.models?.visionItems) || merged.models.visionItems.length === 0) {
    merged.models.visionItems = clone(DEFAULT_CONFIG.models.visionItems)
  }
  cache = merged
  cacheMtime = stat === null ? 0 : stat.mtimeMs
  return clone(merged)
}

/** Replace the stored configuration (deep merge on the file, atomic write). */
export function writeConfig(patch) {
  const next = mergeDeep(readConfig(), patch)
  next.version = DEFAULT_CONFIG.version
  if (!Array.isArray(next.apiKeys)) next.apiKeys = []
  next.apiKeys = next.apiKeys.map((entry, index) => normalizeKeyEntry(entry, index)).filter((entry) => entry !== null)
  if (!Array.isArray(next.models.items) || next.models.items.length === 0) next.models.items = clone(DEFAULT_CONFIG.models.items)
  if (!Array.isArray(next.models.visionItems) || next.models.visionItems.length === 0) next.models.visionItems = clone(DEFAULT_CONFIG.models.visionItems)
  writeFileAtomic(configPath(), `${JSON.stringify(next, null, 2)}\n`, 0o600)
  cache = null
  cacheMtime = 0
  return readConfig()
}

export function normalizeKeyEntry(entry, index = 0) {
  if (entry === null || typeof entry !== 'object') return null
  const key = typeof entry.key === 'string' ? entry.key.trim() : ''
  const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : `key-${index + 1}`
  if (key.length === 0 && entry.keep !== true) return null
  const out = {
    id,
    label: typeof entry.label === 'string' && entry.label.trim().length > 0 ? entry.label.trim() : `Key ${index + 1}`,
    enabled: entry.enabled !== false,
    weight: Number.isFinite(Number(entry.weight)) ? Math.max(1, Math.min(100, Math.round(Number(entry.weight)))) : 1,
  }
  if (key.length > 0) out.key = key
  return out
}

/**
 * Mask a secret for transport: keep a short prefix and the last four characters so
 * an operator can tell two keys apart without the value leaving the Host.
 */
export function maskKey(key) {
  if (typeof key !== 'string' || key.length === 0) return ''
  if (key.length <= 10) return `${key.slice(0, 2)}${'*'.repeat(Math.max(1, key.length - 2))}`
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

/** A configuration safe to hand to a browser: no raw secrets. */
export function publicConfig(config = readConfig()) {
  const out = clone(config)
  out.apiKeys = (config.apiKeys || []).map((entry) => ({
    id: entry.id,
    label: entry.label,
    enabled: entry.enabled !== false,
    weight: entry.weight ?? 1,
    masked: maskKey(entry.key),
    hasKey: typeof entry.key === 'string' && entry.key.length > 0,
    length: typeof entry.key === 'string' ? entry.key.length : 0,
  }))
  out.paths = { root: pluginRoot(), config: configPath(), history: workspaceRoot(), assets: path.join(pluginRoot(), 'assets') }
  out.env = {
    seedKeys: (process.env.PIXELFLY_API_KEYS || '').split(/[\s,]+/).filter(Boolean).length,
    baseUrlOverride: typeof process.env.PIXELFLY_BASE_URL === 'string' ? process.env.PIXELFLY_BASE_URL.trim() : '',
  }
  out.sizes = sizesFor(config)
  return out
}

/** The sizes to offer for the configured provider. */
export function sizesFor(config = readConfig()) {
  const provider = config.upstream?.provider ?? 'sensenova'
  if (provider === 'sensenova') return [...SENSENOVA_SIZES]
  if (provider === 'gemini') return ['1024x1024', '1344x768', '768x1344', '1152x896', '896x1152']
  return [...OPENAI_SIZES]
}

/** Every enabled key, in configured order. Falls back to the environment seed. */
export function activeKeys(config = readConfig()) {
  const fromConfig = (config.apiKeys || []).filter((entry) => entry.enabled !== false && typeof entry.key === 'string' && entry.key.length > 0)
  if (fromConfig.length > 0) return fromConfig
  const seed = (process.env.PIXELFLY_API_KEYS || '').split(/[\s,]+/).filter(Boolean)
  return seed.map((key, index) => ({ id: `env-${index + 1}`, label: `Env key ${index + 1}`, enabled: true, weight: 1, key }))
}

/** The upstream base URL, honouring the environment override. */
export function baseUrl(config = readConfig()) {
  const override = typeof process.env.PIXELFLY_BASE_URL === 'string' ? process.env.PIXELFLY_BASE_URL.trim() : ''
  const raw = override.length > 0 ? override : String(config.upstream?.baseUrl || DEFAULT_CONFIG.upstream.baseUrl)
  return raw.replace(/\/+$/, '')
}

export { ensureDir, writeFileAtomic }
