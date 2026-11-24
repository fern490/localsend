export function formatBytes(b = 0) {
  if (b < 1024) return `${b} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let i = -1
  do {
    b /= 1024
    i++
  } while (b >= 1024 && i < units.length - 1)
  return `${b.toFixed(b < 10 ? 2 : b < 100 ? 1 : 0)} ${units[i]}`
}

/** 734003200 -> "734.003.200" (para comparar el peso exacto con la PC) */
export const exactBytes = (b) => String(b).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

export const formatSpeed = (bps) => (bps ? `${(bps / 1048576).toFixed(1)} MB/s` : '—')

export function formatEta(s) {
  if (s == null || !isFinite(s)) return '—'
  s = Math.max(0, Math.round(s))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`
}

export const STATUS_TEXT = {
  pending: 'Esperando tu respuesta',
  waiting: 'Esperando que la PC acepte…',
  transferring: 'Transfiriendo',
  done: 'Completado',
  rejected: 'Rechazado',
  cancelled: 'Cancelado',
  interrupted: 'Interrumpido',
  error: 'Error'
}
