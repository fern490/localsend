import { Udp, isNativeAvailable } from '../../modules/localsend-native'
import { Emitter } from './emitter'
import { APP_TAG, PROTOCOL_VERSION, UDP_PORT, BROADCAST_ADDR, ANNOUNCE_INTERVAL_MS, DEVICE_TTL_MS } from './protocol'

/**
 * Descubrimiento por UDP broadcast (mismo protocolo que la PC).
 * El socket real vive en Kotlin (modules/localsend-native); acá sólo
 * armamos/parseamos los beacons y llevamos la lista con TTL.
 *
 * Eventos: 'devices', 'status', 'connect-request'
 */
export class Discovery extends Emitter {
  constructor(getInfo) {
    super()
    this.getInfo = getInfo
    this.devices = new Map()
    this.listening = false
    this.error = null
    this.timers = []
    this.subs = []
  }

  async start() {
    this.stop()
    if (!isNativeAvailable) {
      this._status(false, 'Descubrimiento no disponible en Expo Go: conectá por IP')
      return
    }
    this.subs.push(Udp.onMessage((e) => this._onMessage(e)))
    this.subs.push(Udp.onError((e) => this.emit('udp-error', e.message)))
    try {
      await Udp.start(UDP_PORT)
      this._status(true, null)
      this.announce()
    } catch (err) {
      this._status(false, err.message)
      return
    }
    this.timers.push(setInterval(() => this.announce(), ANNOUNCE_INTERVAL_MS))
    this.timers.push(setInterval(() => this._sweep(), 1000))
  }

  stop() {
    this.timers.forEach(clearInterval)
    this.timers = []
    this.subs.forEach((s) => s.remove())
    this.subs = []
    if (isNativeAvailable) Udp.stop()
    this.listening = false
  }

  _status(listening, error) {
    this.listening = listening
    this.error = error
    this.emit('status', { listening, error })
  }

  _packet(type) {
    const info = this.getInfo()
    return JSON.stringify({
      app: APP_TAG,
      version: PROTOCOL_VERSION,
      type,
      id: info.id,
      alias: info.alias,
      deviceType: 'mobile',
      port: 0 // el celular no tiene servidor: siempre se conecta él
    })
  }

  announce() {
    if (!this.listening) return
    const packet = this._packet('announce')
    const targets = new Set([BROADCAST_ADDR, ...Udp.broadcastAddresses()])
    for (const host of targets) Udp.send(packet, host, UDP_PORT)
  }

  _onMessage({ data, address }) {
    let msg
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (msg.app !== APP_TAG || !msg.id || msg.id === this.getInfo().id) return

    const device = {
      id: msg.id,
      alias: String(msg.alias || 'Desconocido').slice(0, 64),
      deviceType: msg.deviceType || 'desktop',
      ip: address,
      port: Number(msg.port) || 0,
      lastSeen: Date.now()
    }
    const prev = this.devices.get(msg.id)
    this.devices.set(msg.id, device)

    if (msg.type === 'announce') Udp.send(this._packet('reply'), address, UDP_PORT)
    if (msg.type === 'connect-request') this.emit('connect-request', device)
    if (!prev || prev.alias !== device.alias || prev.ip !== device.ip) this.emit('devices', this.list())
  }

  _sweep() {
    const now = Date.now()
    let changed = false
    for (const [id, d] of this.devices) {
      if (now - d.lastSeen > DEVICE_TTL_MS) {
        this.devices.delete(id)
        changed = true
      }
    }
    if (changed) this.emit('devices', this.list())
  }

  list() {
    // Sólo mostramos dispositivos que tienen servidor (PCs/laptops).
    return [...this.devices.values()].filter((d) => d.port > 0)
  }
}
