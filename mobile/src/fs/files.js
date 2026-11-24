import { File, Directory, Paths } from 'expo-file-system'

/** Carpeta donde guardamos lo recibido (privada de la app). */
export function receivedDir() {
  const dir = new Directory(Paths.document, 'LocalSend')
  if (!dir.exists) dir.create({ intermediates: true })
  return dir
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/** Mismo criterio que en la PC: nos quedamos sólo con el nombre, sin rutas. */
export function sanitizeFileName(name) {
  let clean =
    String(name || '')
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .pop() || 'archivo'
  // eslint-disable-next-line no-control-regex
  clean = clean.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim()
  if (!clean || clean === '.' || clean === '..') clean = 'archivo'
  if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`
  return clean.slice(0, 200)
}

/** "foto.jpg" -> "foto (1).jpg" si ya existe. */
export function uniqueFile(dir, name) {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let file = new File(dir, name)
  let i = 1
  while (file.exists) file = new File(dir, `${stem} (${i++})${ext}`)
  return file
}

export function fileSize(uri) {
  try {
    return new File(uri).size ?? 0
  } catch {
    return 0
  }
}
