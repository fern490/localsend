// Simula la API de expo-file-system (File / Directory / Paths) sobre fs de Node.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
const root = process.env.MOBILE_DOCS || fs.mkdtempSync(path.join(os.tmpdir(), 'mob-'))
const toPath = (parts) => path.join(...parts.map((p) => (typeof p === 'string' ? p : p.uri)))
export const Paths = { document: { uri: root } }
export class Directory {
  constructor(...parts) { this.uri = toPath(parts) }
  get exists() { return fs.existsSync(this.uri) }
  create() { fs.mkdirSync(this.uri, { recursive: true }) }
}
export class File {
  constructor(...parts) { this.uri = toPath(parts) }
  get exists() { return fs.existsSync(this.uri) }
  get size() { return fs.statSync(this.uri).size }
  create() { fs.writeFileSync(this.uri, '') }
  delete() { fs.rmSync(this.uri) }
  async text() { return fs.readFileSync(this.uri, 'utf8') }
  async write(s) { fs.writeFileSync(this.uri, s) }
  open() {
    const fd = fs.openSync(this.uri, 'r+')
    const h = {
      offset: 0,
      get size() { return fs.fstatSync(fd).size },
      async readBytes(n) { const b = Buffer.alloc(n); const r = fs.readSync(fd, b, 0, n, h.offset); h.offset += r; return new Uint8Array(b.buffer, b.byteOffset, r) },
      async writeBytes(bytes) { fs.writeSync(fd, bytes, 0, bytes.length, h.offset); h.offset += bytes.length },
      close() { fs.closeSync(fd) }
    }
    return h
  }
}
