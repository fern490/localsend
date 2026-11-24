import http from 'node:http'
import { EventEmitter } from 'node:events'
import { WebSocketServer } from 'ws'
import { WS_PATH } from './protocol.js'

/**
 * Servidor TCP de escucha: HTTP + WebSocket en el mismo puerto (53318).
 *  - GET /info  -> datos del dispositivo (útil para probar con el navegador
 *                  o con "Conectar por IP" si el broadcast está bloqueado).
 *  - /ws        -> upgrade a WebSocket: negociación + flujo binario.
 *
 * Eventos: 'connection' (ws, ip), 'status' ({ listening, error })
 */
export class LocalServer extends EventEmitter {
  constructor({ port, getInfo }) {
    super()
    this.port = port
    this.getInfo = getInfo
    this.listening = false
  }

  start() {
    this.http = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(this.getInfo()))
        return
      }
      res.writeHead(404)
      res.end()
    })

    // maxPayload: ningún frame puede superar 4 MB (nuestros chunks son de
    // 256 KB). Protege la RAM de un cliente que mande frames gigantes.
    this.wss = new WebSocketServer({ server: this.http, path: WS_PATH, maxPayload: 4 * 1024 * 1024 })
    this.wss.on('connection', (ws, req) => {
      const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
      this.emit('connection', ws, ip)
    })

    this.http.on('error', (err) => {
      this.listening = false
      this.emit('status', { listening: false, error: err.message })
      if (err.code === 'EADDRINUSE') {
        setTimeout(() => this.http.listen(this.port, '0.0.0.0'), 3000)
      }
    })
    this.http.on('listening', () => {
      this.listening = true
      this.emit('status', { listening: true, error: null })
    })
    this.http.listen(this.port, '0.0.0.0')
  }

  stop() {
    this.wss?.clients.forEach((c) => c.terminate())
    this.wss?.close()
    this.http?.close()
    this.listening = false
  }
}
