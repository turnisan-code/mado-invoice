// Minimal ZIP writer: STORE only (the PDFs are compressed already), so an entry needs nothing but
// its CRC-32 and size, and entries can be streamed one at a time with only the central
// directory kept in memory. No ZIP64: at most 65 535 entries and 4 GiB.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  name: string
  data: Uint8Array
  modified?: Date
}

const UTF8_NAMES = 0x0800
const VERSION = 20
const MAX_ENTRIES = 0xffff
const MAX_OFFSET = 0xffffffff

// MS-DOS timestamps have no time zone; the parts are taken as given (UTC on the server).
function dosDateTime(d: Date) {
  const year = Math.max(1980, d.getUTCFullYear())
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  }
}

function localHeader(name: Uint8Array, crc: number, size: number, time: number, date: number): Uint8Array {
  const out = new Uint8Array(30 + name.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x04034b50, true)
  v.setUint16(4, VERSION, true)
  v.setUint16(6, UTF8_NAMES, true)
  v.setUint16(8, 0, true)
  v.setUint16(10, time, true)
  v.setUint16(12, date, true)
  v.setUint32(14, crc, true)
  v.setUint32(18, size, true)
  v.setUint32(22, size, true)
  v.setUint16(26, name.length, true)
  v.setUint16(28, 0, true)
  out.set(name, 30)
  return out
}

function centralHeader(name: Uint8Array, crc: number, size: number, time: number, date: number, offset: number): Uint8Array {
  const out = new Uint8Array(46 + name.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x02014b50, true)
  v.setUint16(4, VERSION, true)
  v.setUint16(6, VERSION, true)
  v.setUint16(8, UTF8_NAMES, true)
  v.setUint16(10, 0, true)
  v.setUint16(12, time, true)
  v.setUint16(14, date, true)
  v.setUint32(16, crc, true)
  v.setUint32(20, size, true)
  v.setUint32(24, size, true)
  v.setUint16(28, name.length, true)
  // extra length, comment length, disk number, internal and external attributes: all zero
  v.setUint32(42, offset, true)
  out.set(name, 46)
  return out
}

function endRecord(count: number, size: number, offset: number): Uint8Array {
  const out = new Uint8Array(22)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x06054b50, true)
  v.setUint16(8, count, true)
  v.setUint16(10, count, true)
  v.setUint32(12, size, true)
  v.setUint32(16, offset, true)
  return out
}

// Pulls one entry at a time from `entries`, so a slow source (e.g. a storage download per
// file) is only read as fast as the client downloads.
export function createZipStream(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>): ReadableStream<Uint8Array> {
  const iterator: AsyncIterator<ZipEntry> | Iterator<ZipEntry> = Symbol.asyncIterator in entries
    ? (entries as AsyncIterable<ZipEntry>)[Symbol.asyncIterator]()
    : (entries as Iterable<ZipEntry>)[Symbol.iterator]()
  const encoder = new TextEncoder()
  const central: Uint8Array[] = []
  let offset = 0

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next()
      if (next.done) {
        let size = 0
        for (const record of central) {
          controller.enqueue(record)
          size += record.length
        }
        if (offset + size > MAX_OFFSET) throw new Error('ZIP exceeds 4 GiB')
        controller.enqueue(endRecord(central.length, size, offset))
        controller.close()
        return
      }
      const { name, data, modified } = next.value
      const nameBytes = encoder.encode(name)
      const { time, date } = dosDateTime(modified ?? new Date())
      const crc = crc32(data)
      const local = localHeader(nameBytes, crc, data.length, time, date)
      if (central.length >= MAX_ENTRIES || offset + local.length + data.length > MAX_OFFSET) {
        throw new Error('ZIP exceeds 65 535 entries or 4 GiB')
      }
      controller.enqueue(local)
      controller.enqueue(data)
      central.push(centralHeader(nameBytes, crc, data.length, time, date, offset))
      offset += local.length + data.length
    },
    async cancel() {
      await iterator.return?.()
    },
  })
}
