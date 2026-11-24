// Prueba de integración: lógica real del celular (con Expo simulado) contra el nodo real de la PC.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { LocalSendNode } from '../../desktop/src/main/core/node.js'
import { MobileNode } from '../src/net/node.js'
import { fgsLog } from '../modules/localsend-native'

const tmp = process.env.MOBILE_DOCS
const pcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'))
let fails = 0
const ok = (c, m) => { console.log(`${c ? '  ✔' : '  ✘'} ${m}`); if (!c) fails++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
async function makeFile(p, mb) { const o = fs.createWriteStream(p); for (let i = 0; i < mb; i++) if (!o.write(crypto.randomBytes(1048576))) await new Promise((r) => o.once('drain', r)); await new Promise((r) => o.end(r)) }
const FINAL = ['done', 'rejected', 'cancelled', 'error', 'interrupted']
const waitFinal = (node, id) => new Promise((res) => { const off = node.on('transfer', (s) => { if (s.id === id && FINAL.includes(s.status)) { (off ? off() : node.off('transfer', h)); res(s) } }); var h })
function waitFinalDesktop(node, id) { return new Promise((res) => { const h = (s) => { if (s.id === id && FINAL.includes(s.status)) { node.off('transfer', h); res(s) } }; node.on('transfer', h) }) }

const PC = new LocalSendNode({ getSettings: () => ({ id: 'pc-1', alias: 'PC Aula', deviceType: 'desktop', downloadDir: pcDir }), wsPort: 53518 })
PC.on('incoming', (r) => setTimeout(() => PC.respond(r.id, true, {}), 30))
const M = new MobileNode(() => ({ id: 'cel-1', alias: 'Cereza Valiente' }))
M.on('incoming', (r) => setTimeout(() => M.respond(r.id, true), 30))

PC.start()
const t0 = Date.now()
await M.start()
// 1) Descubrimiento
let found = false
while (Date.now() - t0 < 5000) { if (M.getDevices().some((d) => d.id === 'pc-1') && PC.getDevices().some((d) => d.id === 'cel-1')) { found = true; break } await sleep(100) }
console.log('\n1) Descubrimiento UDP mutuo')
ok(found, `Celular y PC se ven en ${((Date.now() - t0) / 1000).toFixed(1)} s (requisito < 5 s)`)
const pcSeen = PC.getDevices().find((d) => d.id === 'cel-1')
ok(pcSeen?.deviceType === 'mobile', `La PC muestra "${pcSeen?.alias}" con icono de celular`)

// 2) Celular -> PC
console.log('\n2) Celular -> PC (imagen + archivo de 60 MB)')
const img = path.join(tmp, 'IMG_0001.jpg'); fs.writeFileSync(img, crypto.randomBytes(800 * 1024))
const vid = path.join(tmp, 'video.mp4'); await makeFile(vid, 60)
let id = await M.sendFiles('pc-1', [
  { uri: img, name: 'IMG_0001.jpg', size: fs.statSync(img).size, mime: 'image/jpeg' },
  { uri: vid, name: '/storage/emulated/0/DCIM/video.mp4', size: fs.statSync(vid).size, mime: 'video/mp4' }
])
let r = await waitFinal(M, id)
ok(r.status === 'done', `Estado en el celular: ${r.status} ${r.error || ''}`)
ok(sha(path.join(pcDir, 'IMG_0001.jpg')) === sha(img), 'Imagen íntegra en la carpeta de la PC')
ok(sha(path.join(pcDir, 'video.mp4')) === sha(vid), 'Video íntegro (la ruta Android se limpió a "video.mp4")')
ok(r.files.every((f) => f.finalSize === f.size), 'El celular recibió la confirmación de tamaño exacto')

// 3) PC -> celular (estrés)
console.log('\n3) PC -> celular (200 MB)')
fgsLog.length = 0
const big = path.join(os.tmpdir(), 'pelicula.mkv'); await makeFile(big, 200)
let maxRss = 0; const mt = setInterval(() => (maxRss = Math.max(maxRss, process.memoryUsage().rss)), 50)
const ts = Date.now()
id = await PC.sendFiles('cel-1', [big])
r = await waitFinalDesktop(PC, id)
await new Promise((res) => { const chk = () => [...M.transfers.values()].some((t) => t.direction === 'in' && t.status === 'done') ? res() : setTimeout(chk, 20); chk() })
clearInterval(mt)
const received = path.join(tmp, 'LocalSend', 'pelicula.mkv')
ok(r.status === 'done', `Estado en la PC: ${r.status} ${r.error || ''} (${((Date.now() - ts) / 1000).toFixed(1)} s)`)
ok(fs.existsSync(received) && sha(received) === sha(big), 'Archivo íntegro en el celular (SHA-256 idéntico)')
ok(fs.statSync(received).size === fs.statSync(big).size, `Peso exacto: ${fs.statSync(received).size} bytes en ambos`)
ok(maxRss < 300 * 1048576, `RAM máxima ${(maxRss / 1048576).toFixed(0)} MB (PC + celular en el mismo proceso)`)
const fgs = fgsLog.map((x) => x[0])
ok(fgs[0] === "start" && fgs.includes('update') && fgs.at(-1) === 'stop', `Foreground service: start → ${fgs.filter((x) => x === 'update').length} updates → stop`)

// 4) Corte y reanudación desde el celular
console.log('\n4) Corte de Wi-Fi a mitad (celular -> PC) y reanudación')
fs.rmSync(path.join(pcDir, 'video.mp4'))
const vid2 = path.join(tmp, 'clase.mp4'); await makeFile(vid2, 80)
id = await M.sendFiles('pc-1', [{ uri: vid2, name: 'clase.mp4', size: fs.statSync(vid2).size, mime: 'video/mp4' }])
const fin = waitFinal(M, id)
await new Promise((res) => { const off = M.on('transfer', (s) => { if (s.id === id && s.bytesDone > 30 * 1048576) { off(); res() } }) })
M.peers.get('pc-1').ws.close()
r = await fin
ok(r.status === 'interrupted' && r.resumable, `Celular: "${r.status}" → ${r.error}`)
await sleep(300)
const inc = new Promise((res) => PC.once('incoming', res))
id = await M.retry(id)
const resumeFrom = (await inc).files[0].resumeFrom
r = await waitFinal(M, id)
ok(resumeFrom > 25 * 1048576, `La PC reanudó desde ${(resumeFrom / 1048576).toFixed(1)} MB`)
ok(r.status === 'done' && sha(path.join(pcDir, 'clase.mp4')) === sha(vid2), 'Archivo reanudado íntegro')

// 5) Rechazo desde la PC
console.log('\n5) Rechazo')
PC.removeAllListeners('incoming'); PC.on('incoming', (q) => PC.respond(q.id, false))
id = await M.sendFiles('pc-1', [{ uri: img, name: 'IMG_0001.jpg', size: fs.statSync(img).size, mime: 'image/jpeg' }])
r = await waitFinal(M, id)
ok(r.status === 'rejected', `El celular muestra: ${r.error}`)

M.stop(); PC.stop()
for (const p of M.peers.values()) p.close()
console.log(fails ? `\n${fails} FALLAS` : '\nTODO OK')
process.exit(fails ? 1 : 0)
