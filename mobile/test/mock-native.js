// Simula modules/localsend-native con dgram de Node.
import dgram from 'node:dgram'
export const isNativeAvailable = true
let sock = null
const subs = { msg: new Set(), err: new Set() }
export const fgsLog = []
export const Udp = {
  start: (port) => new Promise((res, rej) => {
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    sock.on('message', (b, r) => subs.msg.forEach((f) => f({ data: b.toString(), address: r.address, port: r.port })))
    sock.on('error', rej)
    sock.bind(port, '0.0.0.0', () => { sock.setBroadcast(true); res(true) })
  }),
  send: (m, h, p) => { sock?.send(m, p, h, () => {}); return true },
  stop: () => { try { sock?.close() } catch {} sock = null },
  onMessage: (cb) => { subs.msg.add(cb); return { remove: () => subs.msg.delete(cb) } },
  onError: (cb) => { subs.err.add(cb); return { remove: () => subs.err.delete(cb) } },
  broadcastAddresses: () => [],
  localIp: () => '127.0.0.1'
}
export const ForegroundService = {
  start: (t, x) => fgsLog.push(['start', t]),
  update: (t, x, p) => fgsLog.push(['update', Math.round(p)]),
  stop: () => fgsLog.push(['stop'])
}
