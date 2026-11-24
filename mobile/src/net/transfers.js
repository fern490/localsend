import { File } from 'expo-file-system'
import { Emitter, uuid } from './emitter'
import { ACCEPT_TIMEOUT_MS, ACK_TIMEOUT_MS, ACK_EVERY, MOBILE_CHUNK_SIZE, MOBILE_WINDOW } from './protocol'
import { receivedDir, sanitizeFileName, uniqueFile } from '../fs/files'

const FINAL = ['done', 'rejected', 'cancelled', 'error', 'interrupted']

/** Estado común + velocidad/ETA + throttle de actualizaciones a la UI. */
class Transfer extends Emitter {
  constructor(id, direction, peer) {
    super()
    this.id = id
    this.direction = direction
    this.peer = peer
    this.status = 'waiting'
    this.error = null
    this.resumable = false
    this.samples = []
    this.lastEmit = 0
    this.current = null
  }

  totalBytes() {
    return this.files.filter((f) => f.status !== 'skipped').reduce((a, f) => a + f.size, 0)
  }

  speed() {
    const s = this.samples
    if (s.length < 2) return 0
    const dt = (s[s.length - 1][0] - s[0][0]) / 1000
    return dt > 0 ? Math.max(0, (s[s.length - 1][1] - s[0][1]) / dt) : 0
  }

  snapshot() {
    const done = this.bytesDone()
    const total = this.totalBytes()
    const speed = this.speed()
    return {
      id: this.id,
      direction: this.direction,
      peerId: this.peer.id,
      peerAlias: this.peer.info?.alias || this.peer.ip,
      status: this.status,
      error: this.error,
      resumable: this.resumable,
      files: this.files.map((f) => ({
        fileId: f.fileId,
        name: f.name,
        size: f.size,
        mime: f.mime,
        status: f.status,
        uri: f.uri || null,
        savedUri: f.savedUri || null,
        finalSize: f.finalSize ?? null
      })),
      currentFile: this.current?.name || null,
      currentUri: this.current?.uri || null,
      currentMime: this.current?.mime || null,
      bytesDone: done,
      totalBytes: total,
      speed,
      eta: speed > 0 ? (total - done) / speed : null
    }
  }

  // Máximo 5 actualizaciones por segundo hacia React: más trabaría la UI.
  changed(force = false) {
    const now = Date.now()
    this.samples.push([now, this.bytesDone()])
    while (this.samples.length > 2 && now - this.samples[0][0] > 2000) this.samples.shift()
    if (!force && now - this.lastEmit < 200) return
    this.lastEmit = now
    this.emit('update', this.snapshot())
  }
}

/* ═══════════════════════════════ ENVÍO ═══════════════════════════════ */

export class OutgoingTransfer extends Transfer {
  /** files: [{ uri, name, size, mime }] */
  constructor({ peer, files, id }) {
    super(id || uuid(), 'out', peer)
    this.files = files.map((f, i) => ({ ...f, name: sanitizeFileName(f.name), fileId: String(i), status: 'pending' }))
    this.chunkSize = Math.min(MOBILE_CHUNK_SIZE, peer.info?.maxChunk || MOBILE_CHUNK_SIZE)
    this.window = Math.min(MOBILE_WINDOW, peer.info?.window || MOBILE_WINDOW)
    this.acked = 0
    this.doneBytes = 0
    this.cancelled = false
    this._off = peer.on('message', (m) => {
      if (m.transferId !== this.id) return
      if (m.type === 'ack' && this.current && m.fileId === this.current.fileId) {
        this.acked = Math.max(this.acked, Number(m.received) || 0)
        this.changed()
      } else if (m.type === 'cancel') {
        this.cancelled = true
        this.cancelReason = m.local ? 'Cancelado por vos' : m.reason || 'El receptor canceló'
      }
    })
  }

  bytesDone() {
    return this.doneBytes + (this.current ? this.acked : 0)
  }

  async start() {
    const peer = this.peer
    peer.busy = true
    this.changed(true)
    try {
      // 1) Metadatos (JSON): nombre, tamaño, tipo.
      peer.send({
        type: 'offer',
        transferId: this.id,
        files: this.files.map(({ fileId, name, size, mime }) => ({ fileId, name, size, mime }))
      })
      // 2) HANDSHAKE: no leemos ni un byte hasta que el usuario de la PC acepte.
      const answer = await peer.waitFor(
        (m) => m.transferId === this.id && ['accept', 'reject', 'cancel'].includes(m.type),
        ACCEPT_TIMEOUT_MS,
        'La PC no respondió a tiempo'
      )
      if (this.cancelled) throw new CancelError()
      if (answer.type === 'reject') {
        this.status = 'rejected'
        this.error = answer.reason === 'busy' ? 'La PC está ocupada con otra transferencia' : 'La PC rechazó el envío'
        return
      }
      const plan = answer.files || {}
      for (const f of this.files) {
        const p = plan[f.fileId] || { action: 'write', offset: 0 }
        if (p.action === 'skip') f.status = 'skipped'
        f.offset = Math.min(Math.max(0, Number(p.offset) || 0), f.size)
      }
      this.status = 'transferring'
      this.changed(true)
      for (const f of this.files) {
        if (f.status !== 'skipped') await this._sendFile(f)
      }
      peer.send({ type: 'done', transferId: this.id })
      this.status = 'done'
    } catch (err) {
      if (err instanceof CancelError || this.cancelled) {
        this.status = 'cancelled'
        this.error = this.cancelReason || 'Cancelado'
      } else if (peer.closed || peer.ws.readyState !== 1) {
        this.status = 'interrupted'
        this.resumable = true
        this.error = 'Se perdió la conexión. Tocá "Reintentar": se retoma desde donde quedó.'
      } else {
        this.status = 'error'
        this.error = err.message
      }
    } finally {
      this._off()
      peer.busy = false
      this.current = null
      this.changed(true)
    }
  }

  /**
   * Lectura por partes con FileHandle: abrimos el archivo, nos paramos en
   * `offset` y leemos de a 64 KB. Nunca está el archivo entero en memoria.
   */
  async _sendFile(f) {
    const peer = this.peer
    this.current = f
    this.acked = f.offset
    f.status = 'sending'
    peer.send({ type: 'file-start', transferId: this.id, fileId: f.fileId, offset: f.offset })

    const handle = new File(f.uri).open()
    try {
      handle.offset = f.offset
      let sent = f.offset
      while (sent < f.size) {
        if (this.cancelled) throw new CancelError()
        // Control de flujo: como mucho `window` bytes sin confirmar.
        while (sent - this.acked > this.window) {
          await peer.waitFor(
            (m) => m.transferId === this.id && (m.type === 'ack' || m.type === 'cancel'),
            ACK_TIMEOUT_MS,
            'La PC dejó de responder'
          )
          if (this.cancelled) throw new CancelError()
        }
        const bytes = await handle.readBytes(Math.min(this.chunkSize, f.size - sent))
        if (!bytes || bytes.length === 0) throw new Error(`No se pudo leer "${f.name}"`)
        peer.sendBinary(bytes)
        sent += bytes.length
      }
    } finally {
      handle.close()
    }

    peer.send({ type: 'file-end', transferId: this.id, fileId: f.fileId, size: f.size })
    const res = await peer.waitFor(
      (m) => m.transferId === this.id && (m.type === 'cancel' || (['file-ok', 'file-error'].includes(m.type) && m.fileId === f.fileId)),
      ACK_TIMEOUT_MS * 2,
      'La PC no confirmó el archivo'
    )
    if (this.cancelled) throw new CancelError()
    if (res.type === 'file-error') {
      f.status = 'error'
      throw new Error(`La PC reportó un error en "${f.name}": ${res.reason}`)
    }
    f.status = 'done'
    f.finalSize = res.size
    this.doneBytes += f.size
    this.current = null
    this.changed(true)
  }

  cancel() {
    if (FINAL.includes(this.status)) return
    this.cancelled = true
    this.cancelReason = 'Cancelado por vos'
    this.peer.send({ type: 'cancel', transferId: this.id, reason: 'El celular canceló' })
    this.peer.emit('message', { type: 'cancel', transferId: this.id, local: true })
  }
}

class CancelError extends Error {}

/* ══════════════════════════════ RECEPCIÓN ══════════════════════════════ */

export class IncomingTransfer extends Transfer {
  constructor({ peer, offer, resumeStore }) {
    super(String(offer.transferId), 'in', peer)
    this.status = 'pending'
    this.resumeStore = resumeStore
    this.files = (offer.files || []).map((f) => {
      const name = sanitizeFileName(f.name)
      const size = Math.max(0, Number(f.size) || 0)
      return {
        fileId: String(f.fileId),
        name,
        size,
        mime: f.mime || 'application/octet-stream',
        key: `${peer.id}|${name}|${size}`,
        received: 0,
        status: 'pending'
      }
    })
    this._subs = []
  }

  bytesDone() {
    return this.files.filter((f) => f.status !== 'skipped').reduce((a, f) => a + f.received, 0)
  }

  accept() {
    if (this.status !== 'pending') return
    const dir = receivedDir()
    const plan = {}
    for (const f of this.files) {
      // ¿Quedó un archivo a medias de un intento anterior? => reanudamos.
      const prev = this.resumeStore.get(f.key)
      let file = null
      let offset = 0
      if (prev) {
        const old = new File(prev.uri)
        if (old.exists && (old.size ?? 0) <= f.size) {
          file = old
          offset = old.size ?? 0
        }
      }
      if (!file) {
        file = uniqueFile(dir, f.name) // colisión: "Mantener ambos"
        file.create()
      }
      f.file = file
      f.uri = file.uri
      f.offset = offset
      f.received = offset
      plan[f.fileId] = { action: 'write', offset }
    }
    this._subs.push(this.peer.on('message', (m) => this._handle(m)))
    this._subs.push(this.peer.on('chunk', (b) => this._chunk(b)))
    this._subs.push(this.peer.on('close', (r) => this._lost(r)))
    this.status = 'transferring'
    this.peer.send({ type: 'accept', transferId: this.id, files: plan })
    this.changed(true)
  }

  reject() {
    if (this.status !== 'pending') return
    this.peer.send({ type: 'reject', transferId: this.id, reason: 'rejected' })
    this.status = 'rejected'
    this.peer.busy = false
    this.changed(true)
  }

  _handle(m) {
    if (m.transferId !== this.id) return
    if (m.type === 'file-start') this._fileStart(m)
    else if (m.type === 'file-end') this._fileEnd(m)
    else if (m.type === 'done') this._finish()
    else if (m.type === 'cancel') this._abort(m.reason || 'La PC canceló', false)
  }

  _fileStart(m) {
    const f = this.files.find((x) => x.fileId === String(m.fileId))
    if (!f) return
    f.status = 'receiving'
    f.handle = f.file.open()
    f.handle.offset = f.offset
    f.lastAck = f.received
    // Cadena de promesas: las escrituras se hacen en orden, una por vez.
    f.chain = Promise.resolve()
    this.current = f
    this.changed(true)
  }

  _chunk(bytes) {
    const f = this.current
    if (!f || !f.handle) return
    f.chain = f.chain
      .then(async () => {
        await f.handle.writeBytes(bytes)
        f.received += bytes.length
        if (f.received - f.lastAck >= ACK_EVERY) {
          f.lastAck = f.received
          this.peer.send({ type: 'ack', transferId: this.id, fileId: f.fileId, received: f.received })
        }
        this.changed()
      })
      .catch((err) => {
        if (f.status === 'receiving') {
          f.status = 'error'
          this.peer.send({ type: 'file-error', transferId: this.id, fileId: f.fileId, reason: err.message })
          this._abort(`Error al escribir: ${err.message}`, true)
        }
      })
  }

  async _fileEnd(m) {
    const f = this.files.find((x) => x.fileId === String(m.fileId))
    if (!f || !f.handle) return
    this.current = null
    await f.chain
    f.handle.close()
    f.handle = null
    this.peer.send({ type: 'ack', transferId: this.id, fileId: f.fileId, received: f.received })
    // Verificación de integridad: tamaño exacto en bytes.
    const onDisk = new File(f.uri).size ?? 0
    if (onDisk !== f.size) {
      f.status = 'error'
      this.peer.send({ type: 'file-error', transferId: this.id, fileId: f.fileId, reason: `Tamaño incorrecto (${onDisk} de ${f.size})` })
    } else {
      f.status = 'done'
      f.savedUri = f.uri
      f.finalSize = onDisk
      this.resumeStore.delete(f.key)
      this.peer.send({ type: 'file-ok', transferId: this.id, fileId: f.fileId, size: onDisk })
    }
    this.changed(true)
  }

  _finish() {
    const failed = this.files.some((f) => f.status === 'error')
    this.status = failed ? 'error' : 'done'
    if (failed) this.error = 'Algunos archivos no llegaron bien'
    this._detach()
    this.changed(true)
  }

  _lost(reason) {
    if (this.status !== 'transferring') return
    let kept = 0
    for (const f of this.files) {
      try {
        f.handle?.close()
      } catch {
        /* nada */
      }
      f.handle = null
      if (f.status !== 'done' && f.received > 0) {
        this.resumeStore.set(f.key, { uri: f.uri })
        kept += f.received
      }
    }
    this.status = 'interrupted'
    this.resumable = kept > 0
    this.error = this.resumable
      ? `Conexión perdida (${reason}). Se guardó lo recibido: si la PC reintenta, se reanuda.`
      : `Conexión perdida (${reason}). Hay que reiniciar la transferencia.`
    this._detach()
    this.changed(true)
  }

  _abort(reason, notify) {
    if (FINAL.includes(this.status)) return
    if (notify) this.peer.send({ type: 'cancel', transferId: this.id, reason })
    this.status = 'cancelled'
    this.error = reason
    this._detach()
    for (const f of this.files) {
      try {
        f.handle?.close()
      } catch {
        /* nada */
      }
      if (f.status !== 'done') {
        try {
          if (f.file?.exists) f.file.delete()
        } catch {
          /* nada */
        }
        this.resumeStore.delete(f.key)
      }
    }
    this.changed(true)
  }

  cancel() {
    if (this.status === 'pending') return this.reject()
    this._abort('Cancelado por vos', true)
  }

  _detach() {
    this._subs.forEach((off) => off())
    this._subs = []
    this.peer.busy = false
  }
}
