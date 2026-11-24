import dgram from 'node:dgram'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import {
  APP_TAG,
  PROTOCOL_VERSION,
  UDP_PORT,
  BROADCAST_ADDR,
  ANNOUNCE_INTERVAL_MS,
  DEVICE_TTL_MS
} from './protocol.js'

/**
 * Service Discovery por UDP broadcast.
 *
 * - Escucha permanentemente en UDP 53317.
 * - Cada 2 s "grita" a la red un beacon { type:'announce', ... }.
 * - Cuando recibe un announce de otro, le responde directo (unicast) con
 *   { type:'reply' } para que nos vea sin esperar a nuestro próximo beacon.
 * - Cada dispositivo tiene un TTL: si no manda beacons por 6 s se elimina
 *   de la lista (así la lista se actualiza sola si alguien apaga el Wi-Fi).
 *
 * Eventos: 'devices' (lista), 'status' ({ listening }), 'connect-request' (device)
 */
export class Discovery extends EventEmitter {
  constructor({ getInfo, port = UDP_PORT, interval = ANNOUNCE_INTERVAL_MS, ttl = DEVICE_TTL_MS }) {
    super()
    this.getInfo = getInfo // () => { id, alias, deviceType, port }
    this.port = port
    this.interval = interval
    this.ttl = ttl
    this.devices = new Map() // id -> { id, alias, deviceType, ip, port, lastSeen }
    this.listening = false
    this.socket = null
    this.timers = []
  }

  start() {
    this._bind()
    // Barrido del TTL una vez por segundo.
    this.timers.push(setInterval(() => this._sweep(), 1000))
    // Beacon periódico.
    this.timers.push(setInterval(() => this.announce(), this.interval))
  }

  _bind() {
    // reuseAddr permite que otra instancia (o un test) comparta el puerto.
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket

    socket.on('message', (buf, rinfo) => this._onMessage(buf, rinfo))

    socket.on('error', (err) => {
      this._setListening(false, err.message)
      socket.close()
      this.socket = null
      // Reintento: por ejemplo si el puerto estaba ocupado o se cayó la red.
      this.timers.push(setTimeout(() => this._bind(), 3000))
    })

    // 0.0.0.0 = escuchar en TODAS las interfaces (Wi-Fi, Ethernet, etc.)
    socket.bind(this.port, '0.0.0.0', () => {
      // Sin esto el SO rechaza enviar a 255.255.255.255 (EACCES).
      socket.setBroadcast(true)
      this._setListening(true)
      this.announce()
    })
  }

  _setListening(value, error) {
    this.listening = value
    this.emit('status', { listening: value, error: error || null })
  }

  /** Arma el beacon con nuestros datos. */
  _packet(type) {
    const info = this.getInfo()
    return Buffer.from(
      JSON.stringify({
        app: APP_TAG,
        version: PROTOCOL_VERSION,
        type,
        id: info.id,
        alias: info.alias,
        deviceType: info.deviceType,
        port: info.port
      })
    )
  }

  /**
   * Destinos del broadcast. Además de 255.255.255.255 mandamos al broadcast
   * de cada subred (ej. 192.168.1.255). En Windows el broadcast limitado sale
   * sólo por UNA interfaz (la de la ruta por defecto): si la PC tiene
   * VirtualBox/VPN, el beacon podría no salir por el Wi-Fi sin esto.
   */
  broadcastTargets() {
    const targets = new Set([BROADCAST_ADDR])
    for (const ip of subnetBroadcasts()) targets.add(ip)
    return [...targets]
  }

  announce() {
    if (!this.socket || !this.listening) return
    const packet = this._packet('announce')
    for (const target of this.broadcastTargets()) {
      this.socket.send(packet, this.port, target, () => {
        /* errores de envío (red caída) se ignoran: el próximo beacon reintenta */
      })
    }
  }

  /** Envío unicast a un dispositivo concreto (reply o connect-request). */
  sendTo(ip, type, extra = {}) {
    if (!this.socket || !this.listening) return
    const base = JSON.parse(this._packet(type).toString())
    const packet = Buffer.from(JSON.stringify({ ...base, ...extra }))
    this.socket.send(packet, this.port, ip, () => {})
  }

  _onMessage(buf, rinfo) {
    let msg
    try {
      msg = JSON.parse(buf.toString('utf8'))
    } catch {
      return // no es nuestro protocolo
    }
    if (msg.app !== APP_TAG || !msg.id) return
    if (msg.id === this.getInfo().id) return // nuestro propio beacon rebotado

    const isNew = !this.devices.has(msg.id)
    const device = {
      id: msg.id,
      alias: String(msg.alias || 'Desconocido').slice(0, 64),
      deviceType: msg.deviceType || 'desktop',
      ip: rinfo.address, // la IP la tomamos del paquete, no de lo que diga el JSON
      port: Number(msg.port) || 0,
      lastSeen: Date.now()
    }
    const prev = this.devices.get(msg.id)
    this.devices.set(msg.id, device)

    if (msg.type === 'announce') {
      // Le contestamos sólo a él para que nos descubra al instante.
      this.sendTo(rinfo.address, 'reply')
    } else if (msg.type === 'connect-request') {
      this.emit('connect-request', device)
    }

    const changed =
      isNew || !prev || prev.alias !== device.alias || prev.ip !== device.ip || prev.port !== device.port
    if (changed) this.emit('devices', this.list())
  }

  _sweep() {
    const now = Date.now()
    let changed = false
    for (const [id, d] of this.devices) {
      if (now - d.lastSeen > this.ttl) {
        this.devices.delete(id)
        changed = true
      }
    }
    if (changed) this.emit('devices', this.list())
  }

  list() {
    return [...this.devices.values()]
  }

  stop() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    if (this.socket) {
      try {
        this.socket.close()
      } catch {
        /* ya cerrado */
      }
    }
    this.socket = null
    this.listening = false
  }
}

/** IPs locales IPv4 (sin loopback). */
export function localIPv4s() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ address: ni.address, netmask: ni.netmask })
    }
  }
  return out
}

/** Broadcast dirigido de cada subred: ip OR (NOT máscara). */
function subnetBroadcasts() {
  return localIPv4s().map(({ address, netmask }) => {
    const ip = address.split('.').map(Number)
    const mask = netmask.split('.').map(Number)
    return ip.map((octet, i) => (octet | (~mask[i] & 255)) & 255).join('.')
  })
}
