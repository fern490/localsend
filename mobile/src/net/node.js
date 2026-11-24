import { Emitter } from './emitter'
import { Discovery } from './discovery'
import { Peer } from './peer'
import { OutgoingTransfer, IncomingTransfer } from './transfers'
import { WS_PORT } from './protocol'
import { ForegroundService } from '../../modules/localsend-native'
import { formatBytes } from '../ui/format'

const ACTIVE = ['waiting', 'transferring']

/**
 * Orquestador del lado móvil: descubrimiento, conexiones y transferencias.
 * Eventos: 'devices', 'status', 'transfer', 'incoming'
 */
export class MobileNode extends Emitter {
  constructor(getSettings) {
    super()
    this.getSettings = getSettings // () => { id, alias }
    this.peers = new Map()
    this.manual = new Map() // id -> device conectado por IP
    this.transfers = new Map()
    this.retrySpecs = new Map()
    this.resumeStore = new Map()
    this.fgsOn = false
    this.discovery = new Discovery(() => this.getSettings())
    this.discovery.on('devices', () => this.emit('devices', this.getDevices()))
    this.discovery.on('status', (s) => this.emit('status', s))
    // La PC quiere mandarnos algo: nos conectamos nosotros a ella.
    this.discovery.on('connect-request', (d) => this.connect(d).catch(() => {}))
  }

  start() {
    return this.discovery.start()
  }
  stop() {
    this.discovery.stop()
  }
  announce() {
    this.discovery.announce()
  }

  getDevices() {
    const map = new Map(this.discovery.list().map((d) => [d.id, { ...d }]))
    for (const d of this.manual.values()) if (!map.has(d.id)) map.set(d.id, { ...d })
    for (const d of map.values()) d.connected = !!this.peers.get(d.id)
    return [...map.values()].sort((a, b) => a.alias.localeCompare(b.alias))
  }

  local() {
    const s = this.getSettings()
    return { id: s.id, alias: s.alias, deviceType: 'mobile' }
  }

  async connect(device) {
    const existing = this.peers.get(device.id)
    if (existing && !existing.closed) return existing
    const peer = new Peer({ ip: device.ip, port: device.port || WS_PORT, local: this.local() })
    await peer.ready()
    this._register(peer)
    return peer
  }

  /** Plan B si el broadcast está bloqueado (Wi-Fi con "aislamiento de clientes"). */
  async connectIp(address) {
    const [ip, port] = String(address).trim().split(':')
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error('IP inválida (ej: 192.168.1.20)')
    const peer = new Peer({ ip, port: Number(port) || WS_PORT, local: this.local() })
    await peer.ready()
    this._register(peer)
    this.manual.set(peer.id, { ...peer.info, ip, port: Number(port) || WS_PORT, manual: true })
    this.emit('devices', this.getDevices())
    return peer.info
  }

  _register(peer) {
    const old = this.peers.get(peer.id)
    if (old && old !== peer && !old.busy) old.close()
    this.peers.set(peer.id, peer)
    peer.on('message', (m) => {
      if (m.type === 'offer') this._onOffer(peer, m)
    })
    peer.on('close', () => {
      if (this.peers.get(peer.id) === peer) this.peers.delete(peer.id)
      this.emit('devices', this.getDevices())
    })
    this.emit('devices', this.getDevices())
  }

  _track(t) {
    this.transfers.set(t.id, t)
    t.on('update', (snap) => {
      this.emit('transfer', snap)
      this._foreground()
    })
  }

  /**
   * Foreground Service: se prende cuando hay una transferencia activa y se
   * apaga cuando terminan todas. La notificación muestra el porcentaje.
   */
  _foreground() {
    const active = [...this.transfers.values()].filter((t) => ACTIVE.includes(t.status))
    if (active.length === 0) {
      if (this.fgsOn) ForegroundService.stop()
      this.fgsOn = false
      return
    }
    const done = active.reduce((a, t) => a + t.bytesDone(), 0)
    const total = active.reduce((a, t) => a + t.totalBytes(), 0)
    const pct = total > 0 ? (done / total) * 100 : -1
    const t = active[0]
    const title = t.direction === 'out' ? `Enviando a ${t.peer.info?.alias || 'PC'}` : `Recibiendo de ${t.peer.info?.alias || 'PC'}`
    const text = `${formatBytes(done)} de ${formatBytes(total)}`
    if (!this.fgsOn) {
      ForegroundService.start(title, text)
      this.fgsOn = true
      this.lastFgs = 0
    }
    if (Date.now() - (this.lastFgs || 0) > 1000) {
      this.lastFgs = Date.now()
      ForegroundService.update(title, text, pct)
    }
  }

  async sendFiles(deviceId, files, reuseId) {
    const device = this.getDevices().find((d) => d.id === deviceId)
    if (!device) throw new Error('La PC ya no está disponible')
    const peer = await this.connect(device)
    if (peer.busy) throw new Error('Ya hay una transferencia en curso con esa PC')
    const t = new OutgoingTransfer({ peer, files, id: reuseId })
    this._track(t)
    this.retrySpecs.set(t.id, { deviceId, files })
    t.start()
    return t.id
  }

  retry(id) {
    const spec = this.retrySpecs.get(id)
    if (!spec) throw new Error('No se puede reintentar')
    return this.sendFiles(spec.deviceId, spec.files, id)
  }

  _onOffer(peer, offer) {
    if (peer.busy) {
      peer.send({ type: 'reject', transferId: offer.transferId, reason: 'busy' })
      return
    }
    peer.busy = true
    const t = new IncomingTransfer({ peer, offer, resumeStore: this.resumeStore })
    this._track(t)
    const off = peer.on('close', () => {
      off()
      if (t.status === 'pending') {
        t.status = 'cancelled'
        t.error = 'La PC se desconectó'
        t.changed(true)
      }
    })
    setTimeout(() => t.status === 'pending' && t.reject(), 58_000)
    t.changed(true)
    this.emit('incoming', t.snapshot())
  }

  respond(id, accepted) {
    const t = this.transfers.get(id)
    if (!t || t.direction !== 'in') return
    try {
      accepted ? t.accept() : t.reject()
    } catch (err) {
      t.status = 'error'
      t.error = err.message
      t.changed(true)
    }
  }

  cancel(id) {
    this.transfers.get(id)?.cancel()
  }

  clearFinished() {
    for (const [id, t] of this.transfers) {
      if (!['pending', ...ACTIVE].includes(t.status)) {
        this.transfers.delete(id)
        this.retrySpecs.delete(id)
      }
    }
  }
}
