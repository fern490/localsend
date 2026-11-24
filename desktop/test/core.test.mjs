// Prueba del núcleo de red sin Electron: dos nodos en la misma máquina.
// Uso:  node test/core.test.mjs   (desde la carpeta desktop/, con `npm install` hecho)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { LocalSendNode } from '../src/main/core/node.js'
import { Discovery } from '../src/main/core/discovery.js'
import { sanitizeFileName } from '../src/main/core/fsutils.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-test-'))
const dirA = path.join(tmp, 'A')
const dirB = path.join(tmp, 'B')
fs.mkdirSync(dirA)
fs.mkdirSync(dirB)

let failures = 0
const ok = (cond, msg) => {
  console.log(`${cond ? '  ✔' : '  ✘'} ${msg}`)
  if (!cond) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

async function makeFile(p, mb) {
  const out = fs.createWriteStream(p)
  for (let i = 0; i < mb; i++) {
    if (!out.write(crypto.randomBytes(1024 * 1024))) await new Promise((r) => out.once('drain', r))
  }
  await new Promise((r) => out.end(r))
}

const A = new LocalSendNode({
  getSettings: () => ({ id: 'node-A', alias: 'PC A', deviceType: 'desktop', downloadDir: dirA }),
  udpPort: 53417,
  wsPort: 53418
})
const B = new LocalSendNode({
  getSettings: () => ({ id: 'node-B', alias: 'PC B', deviceType: 'laptop', downloadDir: dirB }),
  udpPort: 53419,
  wsPort: 53420
})

// B decide según lo que diga `policy`
let policy = { accept: true, decisions: {} }
B.on('incoming', (req) => {
  setTimeout(() => B.respond(req.id, policy.accept, policy.decisions), 50)
})

function waitFinal(node, id) {
  return new Promise((resolve) => {
    const h = (s) => {
      if (s.id === id && ['done', 'rejected', 'cancelled', 'error', 'interrupted'].includes(s.status)) {
        node.off('transfer', h)
        resolve(s)
      }
    }
    node.on('transfer', h)
  })
}
function lastIncoming() {
  return [...B.transfers.values()].filter((t) => t.direction === 'in').pop()
}

A.start()
B.start()
await sleep(500)
ok(A.status.tcp && B.status.tcp, 'Ambos servidores TCP/WS escuchando')
ok(A.status.udp && B.status.udp, 'Ambos sockets UDP escuchando')

// ── 1. Descubrimiento UDP (dos Discovery en el mismo puerto, reuseAddr) ──
{
  console.log('\n1) Descubrimiento UDP')
  const d1 = new Discovery({ getInfo: () => ({ id: 'd1', alias: 'Uno', deviceType: 'desktop', port: 1 }), port: 53499, interval: 300, ttl: 1200 })
  const d2 = new Discovery({ getInfo: () => ({ id: 'd2', alias: 'Dos', deviceType: 'mobile', port: 2 }), port: 53499, interval: 300, ttl: 1200 })
  d1.start()
  d2.start()
  await sleep(1500)
  const seen = d1.list().map((d) => d.alias).concat(d2.list().map((d) => d.alias))
  ok(seen.length > 0, `Beacons recibidos por broadcast: ${JSON.stringify(seen)}`)
  d2.stop()
  await sleep(2000)
  ok(d1.list().length === 0, 'TTL: el dispositivo apagado desaparece de la lista solo')
  d1.stop()
}

// Conectamos A -> B por IP (equivalente a lo que hace connectTo tras descubrir)
await A.connectToAddress('127.0.0.1', 53420)
await sleep(100)
ok(A.getDevices().some((d) => d.alias === 'PC B'), 'A ve a B como conectado')
ok(B.getDevices().some((d) => d.alias === 'PC A'), 'B ve a A (conexión entrante)')

// ── 2. Archivo grande + memoria + integridad ──
console.log('\n2) Archivo grande (400 MB)')
const big = path.join(tmp, 'video.bin')
await makeFile(big, 400)
const bigHash = sha(big)
let maxRss = 0
const memTimer = setInterval(() => (maxRss = Math.max(maxRss, process.memoryUsage().rss)), 50)
let updates = 0
const counter = (s) => s.direction === 'out' && s.status === 'transferring' && updates++
A.on('transfer', counter)
let t0 = Date.now()
let id = await A.sendFiles('node-B', [big])
let res = await waitFinal(A, id)
clearInterval(memTimer)
A.off('transfer', counter)
ok(res.status === 'done', `Estado final: ${res.status} ${res.error || ''}`)
ok(fs.statSync(path.join(dirB, 'video.bin')).size === fs.statSync(big).size, 'Tamaño exacto en destino')
ok(sha(path.join(dirB, 'video.bin')) === bigHash, 'SHA-256 idéntico')
ok(maxRss < 250 * 1024 * 1024, `RAM máxima del proceso ${(maxRss / 1048576).toFixed(0)} MB (archivo de 400 MB, dos nodos)`)
ok(updates > 5, `Progreso fluido: ${updates} actualizaciones, ${((Date.now() - t0) / 1000).toFixed(1)} s`)
ok(fs.readdirSync(dirB).every((f) => !f.endsWith('.part')), 'No quedan archivos .part')

// ── 3. Colisiones ──
console.log('\n3) Colisiones de nombre')
const small = path.join(tmp, 'foto.jpg')
fs.writeFileSync(small, crypto.randomBytes(300 * 1024))
for (const [decision, expectFiles] of [
  ['rename', ['foto.jpg']],
  ['rename', ['foto.jpg', 'foto (1).jpg']],
  ['replace', ['foto.jpg', 'foto (1).jpg']],
  ['skip', ['foto.jpg', 'foto (1).jpg']]
]) {
  policy = { accept: true, decisions: { 0: decision } }
  id = await A.sendFiles('node-B', [small])
  res = await waitFinal(A, id)
  const present = fs.readdirSync(dirB).filter((f) => f.startsWith('foto')).sort()
  ok(res.status === 'done' && JSON.stringify(present) === JSON.stringify([...expectFiles].sort()), `"${decision}" -> ${JSON.stringify(present)}`)
}
const conflictSeen = lastIncoming().snapshot().files[0].conflict
ok(conflictSeen === true, 'El receptor marcó la colisión antes de aceptar')

// ── 4. Rechazo ──
console.log('\n4) Rechazo')
policy = { accept: false }
id = await A.sendFiles('node-B', [small])
res = await waitFinal(A, id)
ok(res.status === 'rejected', `El emisor ve "${res.status}" y no se escribió nada`)
policy = { accept: true, decisions: {} }

// ── 5. Corte de conexión + reanudación ──
console.log('\n5) Corte de Wi-Fi a mitad + reanudación')
fs.rmSync(path.join(dirB, 'video.bin'))
id = await A.sendFiles('node-B', [big])
const finalP = waitFinal(A, id)
// Cortamos cuando el receptor lleva ~120 MB
await new Promise((resolve) => {
  const h = (s) => {
    if (s.id === id && s.bytesDone > 120 * 1048576) {
      B.off('transfer', h)
      resolve()
    }
  }
  B.on('transfer', h)
})
const inT = lastIncoming()
inT.peer.ws.terminate() // simula que se desconecta el cable
res = await finalP
await sleep(200)
ok(res.status === 'interrupted' && res.resumable, `Emisor: "${res.status}", reanudable=${res.resumable}`)
const inSnap = inT.snapshot()
ok(inSnap.status === 'interrupted' && inSnap.resumable, `Receptor: ${inSnap.error}`)
const partial = inSnap.bytesDone
await A.connectToAddress('127.0.0.1', 53420)
const incomingP = new Promise((r) => B.once('incoming', r))
id = await A.retry(id)
const resumed = (await incomingP).files[0].resumeFrom
res = await waitFinal(A, id)
ok(resumed > 100 * 1048576, `Reanudó desde ${(resumed / 1048576).toFixed(1)} MB (tenía ${(partial / 1048576).toFixed(1)} MB)`)
ok(res.status === 'done' && sha(path.join(dirB, 'video.bin')) === bigHash, 'Archivo reanudado íntegro (SHA-256 idéntico)')

// ── 6. Cancelación ──
console.log('\n6) Cancelación')
id = await A.sendFiles('node-B', [big])
setTimeout(() => A.cancel(id), 300)
res = await waitFinal(A, id)
await sleep(300)
ok(res.status === 'cancelled', 'Emisor: cancelado')
ok(lastIncoming().status === 'cancelled', 'Receptor: cancelado')
ok(fs.readdirSync(dirB).every((f) => !f.endsWith('.part')), 'El receptor borró el temporal')

// ── 7. Rutas ──
console.log('\n7) Agnosticismo de rutas')
ok(sanitizeFileName('/storage/emulated/0/DCIM/IMG_01.jpg') === 'IMG_01.jpg', 'Ruta Android -> nombre limpio')
ok(sanitizeFileName('..\\..\\Windows\\evil:na?me.txt') === 'evil_na_me.txt', 'Path traversal + caracteres prohibidos')
ok(sanitizeFileName('CON.txt') === '_CON.txt', 'Nombre reservado de Windows')

A.stop()
B.stop()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(failures ? `\n${failures} FALLAS` : '\nTODO OK')
process.exit(failures ? 1 : 0)
