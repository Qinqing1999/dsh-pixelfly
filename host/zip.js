// dsh-pixelfly — a tiny ZIP reader/writer.
//
// Project export has to be one file a user can keep, and a multi-image version has
// to download as one archive. Both are plain ZIPs, and Node already has the deflate
// codec, so the container itself is the only thing to write. Store-only is used for
// already-compressed payloads (PNG/JPEG); text is deflated.

import zlib from 'node:zlib'

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const END_SIG = 0x06054b50

let table = null

function crcTable() {
  if (table !== null) return table
  const rows = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    rows[index] = value >>> 0
  }
  table = rows
  return table
}

export function crc32(buffer) {
  const rows = crcTable()
  let value = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    value = rows[(value ^ buffer[index]) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

/**
 * Build a ZIP from `[{ name, data, compress? }]`.
 *
 * Names are sanitised to forward slashes and no leading slash so an archive built
 * here can never contain a path that escapes the extraction directory.
 */
export function createZip(entries, options = {}) {
  const now = options.date ?? new Date()
  const { time, day } = dosTime(now)
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = String(entry.name ?? 'file').replace(/\\/g, '/').replace(/^\/+/, '')
    if (name.length === 0 || name.includes('..')) continue
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '')
    const shouldDeflate = entry.compress === true
    const body = shouldDeflate ? zlib.deflateRawSync(data, { level: 9 }) : data
    const method = shouldDeflate ? 8 : 0
    const crc = crc32(data)
    const nameBytes = Buffer.from(name, 'utf8')

    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    nameBytes.copy(local, 30)
    locals.push(local, body)

    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(CENTRAL_SIG, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(day, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    nameBytes.copy(central, 46)
    centrals.push(central)

    offset += local.length + body.length
  }
  const centralSize = centrals.reduce((total, row) => total + row.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END_SIG, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(centrals.length, 8)
  end.writeUInt16LE(centrals.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, ...centrals, end])
}

/**
 * Read a ZIP built by `createZip` (or any store/deflate archive).
 *
 * Only what an import needs: names and bytes. Entries with an absolute path or a
 * `..` segment are rejected rather than sanitised, because an archive that tries
 * that is not one we should half-trust.
 */
export function readZip(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  let endOffset = -1
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 66000); index -= 1) {
    if (bytes.readUInt32LE(index) === END_SIG) { endOffset = index; break }
  }
  if (endOffset < 0) throw new Error('That file is not a ZIP archive')
  const count = bytes.readUInt16LE(endOffset + 10)
  const centralOffset = bytes.readUInt32LE(endOffset + 16)
  const entries = []
  let cursor = centralOffset
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL_SIG) break
    const method = bytes.readUInt16LE(cursor + 10)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const localOffset = bytes.readUInt32LE(cursor + 42)
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    const normal = name.replace(/\\/g, '/')
    if (normal.startsWith('/') || normal.split('/').includes('..')) {
      throw new Error(`The archive contains an unsafe path: ${name}`)
    }
    if (bytes.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`Corrupt entry in the archive: ${name}`)
    const localNameLength = bytes.readUInt16LE(localOffset + 26)
    const localExtraLength = bytes.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = bytes.subarray(dataStart, dataStart + compressedSize)
    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = zlib.inflateRawSync(raw)
    else throw new Error(`Unsupported compression in the archive: ${name}`)
    entries.push({ name: normal, data })
  }
  return entries
}
