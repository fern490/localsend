import fs from 'node:fs'
import path from 'node:path'

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/**
 * Agnosticismo de rutas.
 * El nombre llega del otro dispositivo (por ejemplo Android, que usa "/").
 * 1. Normalizamos "\" y "/" y nos quedamos sólo con el último segmento
 *    (evita path traversal tipo "../../Windows/system32/x.dll").
 * 2. Quitamos caracteres prohibidos en Windows: < > : " / \ | ? * y de control.
 * 3. Evitamos nombres reservados de Windows (CON, NUL, COM1...).
 * Después SIEMPRE armamos la ruta con path.join, que usa el separador del
 * SO donde corre la app (\ en Windows, / en Linux/macOS).
 */
export function sanitizeFileName(name) {
  const base = String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop() || 'archivo'
  let clean = base
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '') // Windows no admite nombres terminados en punto o espacio
    .trim()
  if (!clean || clean === '.' || clean === '..') clean = 'archivo'
  if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`
  return clean.slice(0, 200)
}

/** "foto.jpg" -> "foto (1).jpg", "foto (2).jpg"... el primero que no exista. */
export function uniquePath(dir, fileName) {
  const ext = path.extname(fileName)
  const stem = path.basename(fileName, ext)
  let candidate = path.join(dir, fileName)
  let i = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${i})${ext}`)
    i++
  }
  return candidate
}

/**
 * Resolución de colisiones (pregunta B2 de la defensa).
 * decision: 'replace' | 'rename' | 'skip'
 * Devuelve la ruta final o null si hay que omitir.
 */
export function resolveTarget(dir, safeName, decision) {
  const target = path.join(dir, safeName)
  if (!fs.existsSync(target)) return target // no hay colisión
  switch (decision) {
    case 'replace':
      return target // se sobrescribe al final
    case 'skip':
      return null
    case 'rename':
    default:
      return uniquePath(dir, safeName) // "Mantener ambos"
  }
}

/**
 * Mueve el archivo temporal .part a su nombre final.
 * rename() es atómico dentro del mismo disco: el archivo final nunca queda
 * a medio escribir. Si es "Reemplazar", borramos el viejo recién ahora,
 * cuando el nuevo ya llegó completo.
 */
export async function finalizePart(partPath, finalPath, decision) {
  if (decision === 'replace') await fs.promises.rm(finalPath, { force: true })
  else if (fs.existsSync(finalPath)) finalPath = uniquePath(path.dirname(finalPath), path.basename(finalPath))
  await fs.promises.rename(partPath, finalPath)
  return finalPath
}
