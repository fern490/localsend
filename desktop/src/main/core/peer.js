import { EventEmitter } from 'node:events'
import { HEARTBEAT_MS, PEER_DEAD_MS } from './protocol.js'

/**
 * Envuelve una conexión WebSocket (de la librería `ws`) con otro dispositivo.
 * Se usa igual si la conexión la abrimos nosotros (cliente) o la recibimos
 * (servidor): en P2P cada nodo es cliente y servidor a la vez.
 *
 * Eventos:
 *  'hello'   (info)  el otro se presentó
 *  'message' (msg)   mensaje de control JSON
 *  'chunk'   (Buffer) trozo binario de archivo
 *  'close'   (reason)
 */
export class Peer extends EventEmitter {
  constructor(ws, { local, ip, outbound }) {
    super()
    this.setMaxListeners(50)
    this.ws = ws
    this.ip = ip
    this.outbound = outbound
    this.info = null // datos del hello remoto
    this.closed = false
    this.lastRx = Date.now()
    this.busy = false // una transferencia por conexión a la vez

    ws.binaryType = 'nodebuffer'

    // ─── Distinción metadatos vs. datos (pregunta A2 de la defensa) ───
    // La librería `ws` nos dice si el frame es binario (isBinary).
    //   - frame de TEXTO  => JSON de control (offer, accept, ack...)
    //   - frame BINARIO   => chunk del archivo en curso
    ws.on('message', (data, isBinary) => {
      this.lastRx = Date.now()
      if (isBinary) {
        this.emit('chunk', data)
        return
      }
      let msg
      try {
        msg = JSON.parse(data.toString('utf8'))
      } catch {
        return
      }
      if (msg.type === 'ping') return
      if (msg.type === 'hello') {
        this.info = {
          id: msg.id,
          alias: String(msg.alias || 'Desconocido').slice(0, 64),
          deviceType: msg.deviceType || 'desktop',
          maxChunk: Number(msg.maxChunk) || 64 * 1024,
          window: Number(msg.window) || 2 * 1024 * 1024
        }
        this.emit('hello', this.info)
        return
      }
      this.emit('message', msg)
    })

    ws.on('close', () => this._closed('socket cerrado'))
    ws.on('error', (err) => this._closed(err.message))

    // Latido de aplicación: si el Wi-Fi se corta "en silencio" TCP puede
    // tardar minutos en darse cuenta. Con esto lo detectamos en ~15 s.
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastRx > PEER_DEAD_MS) {
        this._closed('sin respuesta (¿se cortó el Wi-Fi?)')
        try {
          ws.terminate()
        } catch {
          /* nada */
        }
        return
      }
      this.send({ type: 'ping' })
    }, HEARTBEAT_MS)

    // Nos presentamos apenas se abre la conexión.
    if (ws.readyState === 1) this.send({ type: 'hello', ...local })
    else ws.once('open', () => this.send({ type: 'hello', ...local }))
  }

  get id() {
    return this.info?.id
  }

  send(msg) {
    if (this.closed || this.ws.readyState !== 1) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }

  /** Envía un chunk binario. La promesa se resuelve cuando salió al socket. */
  sendBinary(buf) {
    return new Promise((resolve, reject) => {
      if (this.closed || this.ws.readyState !== 1) return reject(new Error('Conexión cerrada'))
      this.ws.send(buf, { binary: true }, (err) => (err ? reject(err) : resolve()))
    })
  }

  /**
   * Espera un mensaje que cumpla `predicate`. Rechaza si se cierra la
   * conexión o si pasa `timeoutMs`. Es la base del handshake.
   */
  waitFor(predicate, timeoutMs, timeoutText = 'Tiempo de espera agotado') {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('Conexión cerrada'))
      const cleanup = () => {
        clearTimeout(timer)
        this.off('message', onMsg)
        this.off('close', onClose)
      }
      const onMsg = (msg) => {
        if (predicate(msg)) {
          cleanup()
          resolve(msg)
        }
      }
      const onClose = (reason) => {
        cleanup()
        reject(new Error(`Conexión perdida: ${reason}`))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(timeoutText))
      }, timeoutMs)
      this.on('message', onMsg)
      this.on('close', onClose)
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
