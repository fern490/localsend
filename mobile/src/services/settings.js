import { File, Paths } from 'expo-file-system'
import { uuid } from '../net/emitter'

/** Alias "humanizado" como en LocalSend: más fácil que leer una IP. */
const ADJECTIVES = ['Alegre', 'Veloz', 'Tranquilo', 'Brillante', 'Curioso', 'Valiente', 'Simpático', 'Genial', 'Audaz', 'Sereno']
const NOUNS = ['Naranja', 'Manzana', 'Mango', 'Kiwi', 'Durazno', 'Limón', 'Pomelo', 'Ananá', 'Frutilla', 'Cereza']
const pick = (a) => a[Math.floor(Math.random() * a.length)]
export const randomAlias = () => `${pick(NOUNS)} ${pick(ADJECTIVES)}`

const file = () => new File(Paths.document, 'settings.json')

/** Lee la configuración guardada o crea una nueva (id estable + alias). */
export async function loadSettings() {
  try {
    const f = file()
    if (f.exists) {
      const data = JSON.parse(await f.text())
      if (data.id && data.alias) return data
    }
  } catch {
    /* archivo corrupto: generamos uno nuevo */
  }
  const fresh = { id: uuid(), alias: randomAlias() }
  await saveSettings(fresh)
  return fresh
}

export async function saveSettings(settings) {
  const f = file()
  if (!f.exists) f.create()
  await f.write(JSON.stringify(settings))
  return settings
}
