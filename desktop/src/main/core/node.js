import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { Discovery, localIPv4s } from './discovery.js'
import { LocalServer } from './server.js'
import { Peer } from './peer.js'
import { OutgoingTransfer, IncomingTransfer } from './transfers.js'
import {
  UDP_PORT,
  WS_PORT,
  WS_PATH,
  DESKTOP_CHUNK_SIZE,
  DESKTOP_WINDOW,
  ACCEPT_TIMEOUT_MS
} from './protocol.js'

/**
 * Nodo P2P: junta descubrimiento (UDP), servidor (TCP/WS), conexiones y
 * transferencias. NO depende de Electron, por eso se puede probar con Node
 * puro (ver desktop/test/). El proceso Main de Electron sólo lo conecta a la UI.
 *
 * Eventos: 'devices', 'status', 'transfer', 'incoming'
 */
export class LocalSendNode extends EventEmitter {
  constructor({ getSettings, udpPort = UDP_PORT, wsPort = WS_PORT, resumeStore = new Map() }) {
    super()
    this.getSettings = getSettings // () => { id, alias, deviceType, downloadDir }
    this.udpPort = udpPort
    this.wsPort = wsPort
    this.resumeStore = resumeStore
    this.peers = new Map() // id -> Peer
    this.transfers = new Map() // transferId -> Transfer
    this.retrySpecs = new Map() // transferId -> { deviceId, paths }
    this.status = { udp: false, tcp: false, udpError: null, tcpError: null }
  }

  info() {
    const s = this.getSettings()
    return { id: s.id, alias: s.alias, deviceType: s.deviceType, port: this.wsPort }
  }

  helloInfo() {
    return { ...this.info(), maxChunk: DESKTOP_CHUNK_SIZE, window: DESKTOP_WINDOW }
  }

  start() {
    this.discovery = new Discovery({ getInfo: () => this.info(), port: this.udpPort })
    this.discovery.on('devices', () => this.emitDevices())
    this.discovery.on('status', ({ listening, error }) => {
      this.status.udp = listening
      this.status.udpError = error
      this.emitStatus()
    })
    this.discovery.on('connect-request', (d) => this.connectTo(d.id).catch(() => {}))

    this.server = new LocalServer({ port: this.wsPort, getInfo: () => this.info() })
    this.server.on('connection', (ws, ip) => this._attach(ws, ip, false))
    this.server.on('status', ({ listening, error }) => {
      this.status.tcp = listening
      this.status.tcpError = error
      this.emitStatus()
    })

    this.discovery.start()
    this.server.start()
    // Si cambia la red (Wi-Fi nuevo) actualizamos las IPs mostradas.
    this.ipTimer = setInterval(() => this.emitStatus(), 5000)
  }

  stop() {
    clearInterval(this.ipTimer)
    for (const p of this.peers.values()) p.close()
    this.discovery?.stop()
    this.server?.stop()
  }

  getStatus() {
    return { ...this.status, ips: localIPv4s().map((x) => x.address), port: this.wsPort }
  }
  emitStatus() {
    this.emit('status', this.getStatus())
  }

  /** Lista para la UI: descubiertos por UDP + conectados a mano por IP. */
  getDevices() {
    const map = new Map()
    for (const d of this.discovery?.list() || []) map.set(d.id, { ...d, connected: false, manual: false })
    for (const p of this.peers.values()) {
      if (!p.info) continue
      const d = map.get(p.id)
      if (d) d.connected = true
      else map.set(p.id, { ...p.info, ip: p.ip, port: 0, connected: true, manual: true, lastSeen: Date.now() })
    }
    return [...map.values()].sort((a, b) => a.alias.localeCompare(b.alias))
  }
  emitDevices() {
    this.emit('devices', this.getDevices())
  }

  /* ───────────────────────── conexiones ───────────────────────── */

  _attach(ws, ip, outbound) {
    const peer = new Peer(ws, { local: this.helloInfo(), ip, outbound })
    peer.once('hello', (info) => {
      if (info.id === this.info().id) return peer.close() // nos conectamos a nosotros mismos
      const old = this.peers.get(info.id)
      if (old && old !== peer && !old.busy) old.close()
      if (!old || !old.busy || old.closed) this.peers.set(info.id, peer)
      this.emitDevices()
      this.emit('peer', peer)
    })
    peer.on('message', (m) => {
      if (m.type === 'offer') this._onOffer(peer, m)
    })
    peer.on('close', () => {
      if (peer.id && this.peers.get(peer.id) === peer) this.peers.delete(peer.id)
      this.emitDevices()
    })
    return peer
  }

  /** Abre (o reutiliza) la conexión con un dispositivo de la lista. */
  async connectTo(deviceId) {
    const existing = this.peers.get(deviceId)
    if (existing && !existing.closed) return existing
    const device = this.getDevices().find((d) => d.id === deviceId)
    if (!device) throw new Error('El dispositivo ya no está disponible')

    if (device.deviceType === 'mobile') {
      // El celular no tiene servidor propio: le pedimos por UDP que se
      // conecte él a nosotros, y usamos esa misma conexión para enviarle.
      this.discovery.sendTo(device.ip, 'connect-request')
      return this._waitPeer(deviceId, 6000)
    }
    return this.connectToAddress(device.ip, device.port || WS_PORT)
  }

  connectToAddress(ip, port = WS_PORT) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${ip}:${port}${WS_PATH}`, {
        handshakeTimeout: 5000,
        maxPayload: 4 * 1024 * 1024
      })
      const peer = this._attach(ws, ip, true)
      const timer = setTimeout(() => {
        peer.close()
        reject(new Error(`No se pudo conectar con ${ip}:${port}`))
      }, 7000)
      peer.once('hello', () => {
        clearTimeout(timer)
        resolve(peer)
      })
      peer.once('close', (reason) => {
        clearTimeout(timer)
        reject(new Error(`No se pudo conectar con ${ip}:${port} (${reason})`))
      })
    })
  }

  _waitPeer(id, timeoutMs) {
    return new Promise((resolve, reject) => {
      const onPeer = (peer) => {
        if (peer.id !== id) return
        clearTimeout(timer)
        this.off('peer', onPeer)
        resolve(peer)
      }
      const timer = setTimeout(() => {
        this.off('peer', onPeer)
        reject(new Error('El celular no respondió. ¿Tiene la app abierta?'))
      }, timeoutMs)
      this.on('peer', onPeer)
    })
  }

  /* ───────────────────────── transferencias ───────────────────────── */

  _track(t) {
    this.transfers.set(t.id, t)
    t.on('update', (snap) => this.emit('transfer', snap))
  }

  getTransfers() {
    return [...this.transfers.values()].map((t) => t.snapshot())
  }

  async sendFiles(deviceId, paths, reuseId) {
    const files = []
    for (const p of paths) {
      const st = await fs.promises.stat(p)
      if (!st.isFile()) throw new Error(`"${path.basename(p)}" es una carpeta: arrastrá los archivos de adentro`)
      files.push({ path: p, name: path.basename(p), size: st.size, mime: guessMime(p) })
    }
    if (files.length === 0) throw new Error('No hay archivos para enviar')

    const peer = await this.connectTo(deviceId)
    if (peer.busy) throw new Error('Ya hay una transferencia en curso con ese dispositivo')

    const t = new OutgoingTransfer({ peer, files, id: reuseId })
    this._track(t)
    this.retrySpecs.set(t.id, { deviceId, paths })
    t.start() // no esperamos: corre en segundo plano y avisa por eventos
    return t.id
  }

  async retry(transferId) {
    const spec = this.retrySpecs.get(transferId)
    if (!spec) throw new Error('No se puede reintentar esta transferencia')
    return this.sendFiles(spec.deviceId, spec.paths, transferId)
  }

  _onOffer(peer, offer) {
    if (peer.busy) {
      peer.send({ type: 'reject', transferId: offer.transferId, reason: 'busy' })
      return
    }
    peer.busy = true
    const t = new IncomingTransfer({
      peer,
      offer,
      downloadDir: this.getSettings().downloadDir,
      resumeStore: this.resumeStore
    })
    this._track(t)

    // Si el emisor se va mientras el usuario todavía no respondió.
    const onClose = () => {
      if (t.status === 'pending') {
        t.status = 'cancelled'
        t.error = 'El emisor se desconectó'
        peer.busy = false
        t.changed(true)
      }
    }
    peer.once('close', onClose)
    // Si nadie responde, rechazamos antes de que el emisor se canse de esperar.
    setTimeout(() => {
      if (t.status === 'pending') t.reject('timeout')
    }, ACCEPT_TIMEOUT_MS - 2000)

    this.emit('incoming', t.snapshot())
    t.changed(true)
  }

  respond(transferId, accepted, decisions = {}) {
    const t = this.transfers.get(transferId)
    if (!t || t.direction !== 'in') return
    if (accepted) return t.accept(decisions)
    return t.reject('rejected')
  }

  cancel(transferId) {
    this.transfers.get(transferId)?.cancel()
  }

  clearFinished() {
    for (const [id, t] of this.transfers) {
      if (!['waiting', 'pending', 'transferring'].includes(t.status)) {
        this.transfers.delete(id)
        this.retrySpecs.delete(id)
      }
    }
  }
}

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.apk': 'application/vnd.android.package-archive'
}
function guessMime(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'
}
