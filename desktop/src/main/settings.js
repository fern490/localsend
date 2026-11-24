import { app } from 'electron'
import path from 'node:path'
import crypto from 'node:crypto'
import Store from 'electron-store'

/**
 * Persistencia de configuración con electron-store (JSON en la carpeta de
 * datos del usuario: %APPDATA%/LocalSend Clase/config.json en Windows,
 * ~/.config/LocalSend Clase/config.json en Linux).
 */
const ADJECTIVES = ['Alegre', 'Veloz', 'Tranquilo', 'Brillante', 'Curioso', 'Valiente', 'Simpático', 'Genial', 'Audaz', 'Sereno']
const NOUNS = ['Naranja', 'Manzana', 'Mango', 'Kiwi', 'Durazno', 'Limón', 'Pomelo', 'Ananá', 'Frutilla', 'Cereza']

export function randomAlias() {
  const pick = (arr) => arr[crypto.randomInt(arr.length)]
  return `${pick(NOUNS)} ${pick(ADJECTIVES)}`
}

export function createSettings() {
  const store = new Store({
    name: 'config',
    defaults: {
      alias: randomAlias(),
      deviceType: 'desktop', // 'desktop' | 'laptop'
      downloadDir: path.join(app.getPath('downloads'), 'LocalSend'),
      showIp: true
    }
  })
  // Identificador estable del dispositivo (no cambia aunque cambie la IP).
  if (!store.get('id')) store.set('id', crypto.randomUUID())

  return {
    get: () => store.store,
    set(patch) {
      const allowed = {}
      if (typeof patch.alias === 'string' && patch.alias.trim()) allowed.alias = patch.alias.trim().slice(0, 40)
      if (['desktop', 'laptop'].includes(patch.deviceType)) allowed.deviceType = patch.deviceType
      if (typeof patch.downloadDir === 'string' && path.isAbsolute(patch.downloadDir)) allowed.downloadDir = patch.downloadDir
      if (typeof patch.showIp === 'boolean') allowed.showIp = patch.showIp
      store.set(allowed)
      return store.store
    }
  }
}
