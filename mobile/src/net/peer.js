import { Emitter } from './emitter'
import { HEARTBEAT_MS, PEER_DEAD_MS, WS_PATH, MOBILE_CHUNK_SIZE, MOBILE_WINDOW } from './protocol'

/**
 * Conexión WebSocket con una PC. El celular siempre es el cliente; por la
 * misma conexión se envía y se recibe (ver PROTOCOLO.md).
 *
 * Eventos: 'hello', 'message', 'chunk' (Uint8Array), 'close'
 */
export class Peer extends Emitter {
  constructor({ ip, port, local }) {
    super()
    this.ip = ip
    this.info = null
    this.closed = false
    this.busy = false
    this.lastRx = Date.now()

    const ws = new WebSocket(`ws://${ip}:${port}${WS_PATH}`)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => this.send({ type: 'hello', ...local, maxChunk: MOBILE_CHUNK_SIZE, window: MOBILE_WINDOW })

    // Metadatos vs. datos: un frame de TEXTO es JSON de control, un frame
    // BINARIO (ArrayBuffer) es un trozo del archivo.
    ws.onmessage = (e) => {
      this.lastRx = Date.now()
      if (typeof e.data !== 'string') {
        this.emit('chunk', new Uint8Array(e.data))
        return
      }
      let msg
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }
      if (msg.type === 'ping') return
      if (msg.type === 'hello') {
        this.info = {
          id: msg.id,
          alias: String(msg.alias || 'PC'),
          deviceType: msg.deviceType || 'desktop',
          maxChunk: Number(msg.maxChunk) || MOBILE_CHUNK_SIZE,
          window: Number(msg.window) || MOBILE_WINDOW
        }
        this.emit('hello', this.info)
        return
      }
      this.emit('message', msg)
    }
    ws.onerror = (e) => this._closed(e?.message || 'error de red')
    ws.onclose = () => this._closed('conexión cerrada')

    // Latido: detecta Wi-Fi caído aunque TCP no avise.
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastRx > PEER_DEAD_MS) {
        this._closed('sin respuesta (¿se cortó el Wi-Fi?)')
        try {
          ws.close()
        } catch {
          /* nada */
        }
        return
      }
      this.send({ type: 'ping' })
    }, HEARTBEAT_MS)
  }

  get id() {
    return this.info?.id
  }

  send(msg) {
    if (this.closed || this.ws.readyState !== 1) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }

  sendBinary(bytes) {
    if (this.closed || this.ws.readyState !== 1) throw new Error('Conexión cerrada')
    this.ws.send(bytes) // Uint8Array => frame binario
  }

  /** Espera un mensaje que cumpla `predicate` (base del handshake). */
  waitFor(predicate, timeoutMs, timeoutText = 'Tiempo de espera agotado') {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('Conexión cerrada'))
      const offMsg = this.on('message', (m) => {
        if (predicate(m)) {
          cleanup()
          resolve(m)
        }
      })
      const offClose = this.on('close', (reason) => {
        cleanup()
        reject(new Error(`Conexión perdida: ${reason}`))
      })
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(timeoutText))
      }, timeoutMs)
      function cleanup() {
        clearTimeout(timer)
        offMsg()
        offClose()
      }
    })
  }

  /** Espera el hello (conexión lista). */
  ready(timeoutMs = 7000) {
    if (this.info) return Promise.resolve(this)
    return new Promise((resolve, reject) => {
      const offHello = this.once('hello', () => {
        cleanup()
        resolve(this)
      })
      const offClose = this.once('close', (r) => {
        cleanup()
        reject(new Error(`No se pudo conectar con ${this.ip} (${r})`))
      })
      const timer = setTimeout(() => {
        cleanup()
        this.close()
        reject(new Error(`No se pudo conectar con ${this.ip}`))
      }, timeoutMs)
      function cleanup() {
        clearTimeout(timer)
        offHello()
        offClose()
      }
    })
  }

  _closed(reason) {
    if (this.closed) return
    this.closed = true
    clearInterval(this.heartbeat)
    this.emit('close', reason)
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* nada */
    }
    this._closed('cerrado localmente')
  }
}
