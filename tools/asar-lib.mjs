/**
 * Minimal asar reader shared by the shell-patch tools.
 *
 * Layout: [u32 4][u32 headerPickleSize] then the header pickle
 * ([u32 payloadSize][u32 jsonLength][json][padding]), then the data section.
 * A file entry's `offset` is relative to the data section, and `size` is its
 * byte length; `unpacked: true` entries live in `app.asar.unpacked` instead.
 */

import { openSync, readSync, closeSync, readFileSync } from 'node:fs'

/** Round up to the next 4-byte boundary. */
export function align4(value) {
  return (value + 3) & ~3
}

/**
 * Read one archive's header and geometry.
 * @param file - path to the `.asar`.
 * @returns the parsed header plus the offsets a writer needs.
 */
export function openAsar(file) {
  const fd = openSync(file, 'r')
  const prefix = Buffer.alloc(8)
  readSync(fd, prefix, 0, 8, 0)
  const headerPickleSize = prefix.readUInt32LE(4)
  const pickle = Buffer.alloc(headerPickleSize)
  readSync(fd, pickle, 0, headerPickleSize, 8)
  const jsonLen = pickle.readUInt32LE(0) - 4
  const jsonStart = 16
  const json = pickle.subarray(8, 8 + jsonLen).toString('utf8')
  const header = JSON.parse(json)
  const dataStart = 8 + headerPickleSize
  return { fd, file, header, jsonText: json, jsonLen, jsonStart, dataStart, headerPickleSize }
}

/** Release an archive handle. */
export function closeAsar(archive) {
  if (archive.fd !== undefined) closeSync(archive.fd)
}

/** Read one entry's bytes out of an opened archive. */
export function readEntry(archive, entry) {
  if (entry.unpacked === true) throw new Error('entry is unpacked')
  const buffer = Buffer.alloc(entry.size)
  readSync(archive.fd, buffer, 0, entry.size, archive.dataStart + Number(entry.offset))
  return buffer
}

/** Every file entry, flattened, in header order. */
export function walkEntries(header) {
  const out = []
  const visit = (node, prefix) => {
    if (node.files === undefined) {
      out.push({ path: prefix, entry: node })
      return
    }
    for (const [name, child] of Object.entries(node.files)) visit(child, prefix === '' ? name : prefix + '/' + name)
  }
  for (const [name, child] of Object.entries(header.files)) visit(child, name)
  return out
}

/** The entry object for one path, or undefined. */
export function findEntry(header, path) {
  const segments = path.split('/')
  let node = { files: header.files }
  for (const segment of segments) {
    if (node.files === undefined) return undefined
    node = node.files[segment]
    if (node === undefined) return undefined
  }
  return node
}

/** Read a whole file (used for the small text entries this tool patches). */
export function readFileText(file) {
  return readFileSync(file, 'utf8')
}
