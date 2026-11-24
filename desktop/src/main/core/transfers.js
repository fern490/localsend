import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  ACCEPT_TIMEOUT_MS,
  ACK_TIMEOUT_MS,
  ACK_EVERY,
  DESKTOP_CHUNK_SIZE,
  DESKTOP_WINDOW
} from './protocol.js'
import { sanitizeFileName, resolveTarget, finalizePart } from './fsutils.js'

/** Velocidad (promedio móvil de los últimos 2 s) y tiempo restante. */
class ProgressMeter {
  constructor() {
    this.samples = []
  }
  update(bytesDone) {
    const now = Date.now()
    this.samples.push([now, bytesDone])
    while (this.samples.length > 2 && now - this.samples[0][0] > 2000) this.samples.shift()
  }
  speed() {
    if (this.samples.length < 2) return 0
    const [t0, b0] = this.samples[0]
    const [t1, b1] = this.samples[this.samples.length - 1]
    const dt = (t1 - t0) / 1000
    return dt > 0 ? Math.max(0, (b1 - b0) / dt) : 0
  }
}

/** Base común: estado serializable para la UI + emisión con throttle. */
class Transfer extends EventEmitter {
  constructor({ id, direction, peer }) {
    super()
    this.id = id
    this.direction = direction
    this.peer = peer
    this.status = 'waiting'
    this.error = null
    this.resumable = false
    this.meter = new ProgressMeter()
    this.lastEmit = 0
    this.startedAt = null
  }

  bytesDone() {
    return 0
  }
  totalBytes() {
    return 0
  }

  snapshot() {
    const done = this.bytesDone()
    const total = this.totalBytes()
    const speed = this.meter.speed()
    return {
      id: this.id,
      direction: this.direction,
      peerId: this.peer.id,
      peerAlias: this.peer.info?.alias,
      peerType: this.peer.info?.deviceType,
      status: this.status,
      error: this.error,
      resumable: this.resumable,
      files: this.files.map((f) => ({
        fileId: f.fileId,
        name: f.name,
        size: f.size,
        status: f.status,
        savedPath: f.savedPath || null,
        conflict: f.conflict || false,
        resumeFrom: f.resumeFrom || 0
      })),
      currentFile: this.current?.name || null,
      bytesDone: done,
      totalBytes: total,
      speed,
      eta: speed > 0 ? (total - done) / speed : null
    }
  }

  /** Avisamos a la UI como máximo cada 150 ms para no saturar el IPC. */
  changed(force = false) {
    const now = Date.now()
    this.meter.update(this.bytesDone())
    if (!force && now - this.lastEmit < 150) return
    this.lastEmit = now
    this.emit('update', this.snapshot())
  }
}

/* ══════════════════════════════ ENVÍO ══════════════════════════════ */

export class OutgoingTransfer extends Transfer {
  /**
   * files: [{ path, name, size, mime }]
   */
  constructor({ peer, files, id, chunkSize = DESKTOP_CHUNK_SIZE, window = DESKTOP_WINDOW }) {
    super({ id: id || crypto.randomUUID(), direction: 'out', peer })
    this.files = files.map((f, i) => ({ ...f, fileId: String(i), status: 'pending' }))
    // Respetamos los límites del receptor (el móvil pide chunks más chicos).
    this.chunkSize = Math.min(chunkSize, peer.info?.maxChunk || chunkSize)
    this.window = Math.min(window, peer.info?.window || window)
    this.acked = 0
    this.doneBytes = 0
    this.cancelled = false
    this.current = null

    this._onMessage = (m) => {
      if (m.transferId !== this.id) return
      if (m.type === 'ack' && this.current && m.fileId === this.current.fileId) {
        this.acked = Math.max(this.acked, Number(m.received) || 0)
        this.changed()
      } else if (m.type === 'cancel') {
        this.cancelled = true
        this.cancelReason = m.local ? 'Cancelado por vos' : m.reason || 'El receptor canceló'
      }
    }
  }

  totalBytes() {
    return this.files.filter((f) => f.status !== 'skipped').reduce((a, f) => a + f.size, 0)
  }
  bytesDone() {
    return this.doneBytes + (this.current ? this.acked : 0)
  }

  async start() {
    const peer = this.peer
    peer.on('message', this._onMessage)
    peer.busy = true
    this.status = 'waiting'
    this.changed(true)
    try {
      // 1) Mandamos los METADATOS (JSON) y...
      peer.send({
        type: 'offer',
        transferId: this.id,
        files: this.files.map(({ fileId, name, size, mime }) => ({ fileId, name, size, mime }))
      })

      // 2) ...el flujo SE DETIENE ACÁ hasta que el usuario receptor decida
      //    (pregunta A3 de la defensa: el handshake). No se lee ni un byte
      //    del archivo antes de recibir 'accept'.
      const answer = await peer.waitFor(
        (m) => m.transferId === this.id && ['accept', 'reject', 'cancel'].includes(m.type),
        ACCEPT_TIMEOUT_MS,
        'El otro dispositivo no respondió a tiempo'
      )
      if (this.cancelled) throw new CancelError(this.cancelReason)
      if (answer.type === 'reject') {
        this.status = 'rejected'
        this.error = answer.reason === 'busy' ? 'El dispositivo está ocupado con otra transferencia' : 'Rechazado por el receptor'
        return
      }

      // 3) Aceptado: vemos qué archivos quiere y desde qué byte (reanudación).
      const plan = answer.files || {}
      for (const f of this.files) {
        const p = plan[f.fileId] || { action: 'write', offset: 0 }
        if (p.action === 'skip') f.status = 'skipped'
        f.offset = Math.min(Math.max(0, Number(p.offset) || 0), f.size)
      }
      this.status = 'transferring'
      this.startedAt = Date.now()
      this.changed(true)

      for (const f of this.files) {
        if (f.status === 'skipped') continue
        await this._sendFile(f)
      }

      peer.send({ type: 'done', transferId: this.id })
      this.status = 'done'
    } catch (err) {
      if (err instanceof CancelError || this.cancelled) {
        this.status = 'cancelled'
        this.error = this.cancelReason || err.message
      } else if (peer.closed || peer.ws.readyState !== 1) {
        // Se cortó la conexión: el receptor guarda lo recibido (.part),
        // así que un reintento retoma desde donde quedó.
        this.status = 'interrupted'
        this.resumable = true
        this.error = 'Se perdió la conexión. Podés reintentar: se reanudará desde donde quedó.'
      } else {
        this.status = 'error'
        this.error = err.message
      }
    } finally {
      peer.off('message', this._onMessage)
      peer.busy = false
      this.current = null
      this.changed(true)
    }
  }

  /**
   * Lectura por STREAM (pregunta B1 de la defensa).
   * fs.createReadStream lee el archivo de a `highWaterMark` bytes. Con
   * `for await` pedimos el siguiente trozo sólo cuando terminamos de mandar
   * el anterior: un archivo de 10 GB nunca está entero en RAM, como mucho
   * hay `window` bytes (8 MB) "en vuelo" sin confirmar.
   */
  async _sendFile(f) {
    const peer = this.peer
    this.current = f
    this.acked = f.offset
    f.status = 'sending'
    peer.send({ type: 'file-start', transferId: this.id, fileId: f.fileId, offset: f.offset })

    let sent = f.offset
    const stream = fs.createReadStream(f.path, { start: f.offset, highWaterMark: this.chunkSize })
    try {
      for await (const chunk of stream) {
        if (this.cancelled) throw new CancelError(this.cancelReason)
        // Control de flujo: si el receptor todavía no confirmó suficientes
        // bytes (disco lento, Wi-Fi lento), esperamos su próximo ack.
        while (sent - this.acked > this.window) {
          await peer.waitFor(
            (m) => m.transferId === this.id && (m.type === 'ack' || m.type === 'cancel'),
            ACK_TIMEOUT_MS,
            'El receptor dejó de responder'
          )
          if (this.cancelled) throw new CancelError(this.cancelReason)
        }
        await peer.sendBinary(chunk) // frame BINARIO
        sent += chunk.length
      }
    } finally {
      stream.destroy()
    }

    peer.send({ type: 'file-end', transferId: this.id, fileId: f.fileId, size: f.size })
    const res = await peer.waitFor(
      (m) =>
        m.transferId === this.id &&
        (m.type === 'cancel' || ((m.type === 'file-ok' || m.type === 'file-error') && m.fileId === f.fileId)),
      ACK_TIMEOUT_MS * 2,
      'El receptor no confirmó el archivo'
    )
    if (this.cancelled) throw new CancelError(this.cancelReason)
    if (res.type === 'file-error') {
      f.status = 'error'
      throw new Error(`El receptor reportó un error en "${f.name}": ${res.reason}`)
    }
    f.status = 'done'
    this.doneBytes += f.size
    this.current = null
    this.changed(true)
  }

  cancel() {
    if (['done', 'cancelled', 'rejected', 'error', 'interrupted'].includes(this.status)) return
    this.cancelled = true
    this.cancelReason = 'Cancelado por vos'
    this.peer.send({ type: 'cancel', transferId: this.id, reason: 'El emisor canceló' })
    // Mensaje sintético local para destrabar cualquier waitFor pendiente.
    this.peer.emit('message', { type: 'cancel', transferId: this.id, local: true })
  }
}

class CancelError extends Error {}

/* ═════════════════════════════ RECEPCIÓN ═════════════════════════════ */

export class IncomingTransfer extends Transfer {
  constructor({ peer, offer, downloadDir, resumeStore }) {
    super({ id: String(offer.transferId), direction: 'in', peer })
    this.downloadDir = downloadDir
    this.resumeStore = resumeStore
    this.status = 'pending'
    this.current = null

    this.files = (Array.isArray(offer.files) ? offer.files : []).map((f) => {
      const name = sanitizeFileName(f.name)
      const size = Math.max(0, Number(f.size) || 0)
      const key = `${peer.id}|${name}|${size}`
      // ¿Tenemos un .part de un intento anterior que se cortó?
      let resumeFrom = 0
      const prev = resumeStore.get(key)
      if (prev && fs.existsSync(prev.partPath)) {
        const partSize = fs.statSync(prev.partPath).size
        if (partSize <= size) resumeFrom = partSize
      }
      return {
        fileId: String(f.fileId),
        name,
        size,
        mime: f.mime || 'application/octet-stream',
        key,
        conflict: fs.existsSync(path.join(downloadDir, name)),
        resumeFrom,
        resumePart: resumeFrom > 0 ? prev.partPath : null,
        received: 0,
        status: 'pending'
      }
    })

    this._onMessage = (m) => this._handle(m)
    this._onChunk = (buf) => this._chunk(buf)
    this._onClose = (reason) => this._lost(reason)
  }

  totalBytes() {
    return this.files.filter((f) => f.status !== 'skipped').reduce((a, f) => a + f.size, 0)
  }
  bytesDone() {
    return this.files.filter((f) => f.status !== 'skipped').reduce((a, f) => a + f.received, 0)
  }

  /** decisions: { [fileId]: 'replace' | 'rename' | 'skip' } para los que colisionan */
  async accept(decisions = {}) {
    if (this.status !== 'pending') return
    await fs.promises.mkdir(this.downloadDir, { recursive: true })
    const plan = {}
    for (const f of this.files) {
      const decision = decisions[f.fileId] === 'skip' ? 'skip' : f.conflict ? decisions[f.fileId] || 'rename' : 'rename'
      if (decision === 'skip') {
        f.status = 'skipped'
        plan[f.fileId] = { action: 'skip' }
        continue
      }
      f.decision = decision
      if (f.resumePart) {
        f.partPath = f.resumePart
        f.offset = f.resumeFrom
        await fs.promises.truncate(f.partPath, f.offset) // por si quedó basura al final
      } else {
        // Archivo temporal: el nombre final recién existe cuando llegó completo.
        f.partPath = path.join(this.downloadDir, `.${f.name}.${crypto.randomBytes(4).toString('hex')}.part`)
        f.offset = 0
      }
      f.received = f.offset
      plan[f.fileId] = { action: 'write', offset: f.offset }
    }

    this.peer.on('message', this._onMessage)
    this.peer.on('chunk', this._onChunk)
    this.peer.on('close', this._onClose)
    this.status = 'transferring'
    this.startedAt = Date.now()
    this.peer.send({ type: 'accept', transferId: this.id, files: plan })
    this.changed(true)
  }

  reject(reason = 'rejected') {
    if (this.status !== 'pending') return
    this.peer.send({ type: 'reject', transferId: this.id, reason })
    this.status = 'rejected'
    this.peer.busy = false
    this.changed(true)
  }

  _handle(m) {
    if (m.transferId !== this.id) return
    switch (m.type) {
      case 'file-start':
        return this._fileStart(m)
      case 'file-end':
        return this._fileEnd(m)
      case 'done':
        return this._finish()
      case 'cancel':
        return this._cancelled(m.reason || 'El emisor canceló', false)
    }
  }

  _fileStart(m) {
    const f = this.files.find((x) => x.fileId === String(m.fileId))
    if (!f || f.status === 'skipped') {
      this.current = null
      return
    }
    f.status = 'receiving'
    f.lastAck = f.received
    // Escritura NO bloqueante: createWriteStream encola en el thread-pool de
    // libuv; el hilo principal (y la UI) siguen libres.
    f.stream = fs.createWriteStream(f.partPath, f.offset > 0 ? { flags: 'r+', start: f.offset } : { flags: 'w' })
    f.stream.on('error', (err) => {
      this.peer.send({ type: 'file-error', transferId: this.id, fileId: f.fileId, reason: err.message })
      this._cancelled(`Error de disco: ${err.message}`, true)
    })
    this.current = f
    this.changed(true)
  }

  _chunk(buf) {
    const f = this.current
    if (!f || !f.stream) return
    const len = buf.length
    f.stream.write(buf, (err) => {
      if (err) return
      // Contamos el byte como recibido recién cuando está escrito en disco.
      f.received += len
      if (f.received - f.lastAck >= ACK_EVERY) {
        f.lastAck = f.received
        this.peer.send({ type: 'ack', transferId: this.id, fileId: f.fileId, received: f.received })
      }
      this.changed()
    })
  }

  async _fileEnd(m) {
    const f = this.files.find((x) => x.fileId === String(m.fileId))
    if (!f || !f.stream) return
    this.current = null
    await new Promise((resolve) => f.stream.end(resolve))
    f.stream = null
    this.peer.send({ type: 'ack', transferId: this.id, fileId: f.fileId, received: f.received })

    // Verificación de integridad: el tamaño en disco tiene que ser EXACTO.
    const onDisk = (await fs.promises.stat(f.partPath)).size
    if (onDisk !== f.size || Number(m.size) !== f.size) {
      f.status = 'error'
      await fs.promises.rm(f.partPath, { force: true })
      this.resumeStore.delete(f.key)
      this.peer.send({
        type: 'file-error',
        transferId: this.id,
        fileId: f.fileId,
        reason: `Tamaño incorrecto (${onDisk} de ${f.size} bytes)`
      })
      this.changed(true)
      return
    }

    const target = resolveTarget(this.downloadDir, f.name, f.decision)
    f.savedPath = await finalizePart(f.partPath, target, f.decision)
    f.status = 'done'
    this.resumeStore.delete(f.key)
    this.peer.send({ type: 'file-ok', transferId: this.id, fileId: f.fileId, size: onDisk })
    this.changed(true)
  }

  _finish() {
    const failed = this.files.some((f) => f.status === 'error')
    this.status = failed ? 'error' : 'done'
    if (failed) this.error = 'Algunos archivos no llegaron bien'
    this._detach()
    this.changed(true)
    this.emit('completed', this.snapshot())
  }

  /** Se cortó la conexión a mitad de camino. */
  _lost(reason) {
    if (this.status !== 'transferring') return
    let kept = 0
    for (const f of this.files) {
      if (f.stream) {
        f.stream.end()
        f.stream = null
      }
      if (['receiving', 'pending'].includes(f.status) && f.partPath && f.received > 0) {
        this.resumeStore.set(f.key, { partPath: f.partPath })
        kept += f.received
      }
    }
    this.status = 'interrupted'
    this.resumable = kept > 0
    this.error = this.resumable
      ? `Conexión perdida (${reason}). Se guardó lo recibido: si el emisor reintenta, se reanuda desde ahí.`
      : `Conexión perdida (${reason}). La transferencia debe reiniciarse.`
    this._detach()
    this.changed(true)
  }

  async _cancelled(reason, notifyPeer) {
    if (['done', 'cancelled', 'rejected', 'interrupted'].includes(this.status)) return
    if (notifyPeer) this.peer.send({ type: 'cancel', transferId: this.id, reason })
    this.status = 'cancelled'
    this.error = reason
    this._detach()
    for (const f of this.files) {
      if (f.stream) {
        f.stream.destroy()
        f.stream = null
      }
      if (f.partPath && f.status !== 'done') {
        await fs.promises.rm(f.partPath, { force: true }).catch(() => {})
        this.resumeStore.delete(f.key)
      }
    }
    this.changed(true)
  }

  cancel() {
    if (this.status === 'pending') return this.reject('rejected')
    return this._cancelled('Cancelado por vos', true)
  }

  _detach() {
    this.peer.off('message', this._onMessage)
    this.peer.off('chunk', this._onChunk)
    this.peer.off('close', this._onClose)
    this.peer.busy = false
  }
}
