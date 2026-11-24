/** Modo oscuro/claro automático según el sistema (useColorScheme). */
export function makeTheme(scheme) {
  const dark = scheme !== 'light'
  return dark
    ? {
        dark,
        bg: '#0f1115',
        card: '#171a21',
        card2: '#1e222b',
        border: '#2a2f3a',
        text: '#e8eaf0',
        muted: '#8b93a7',
        accent: '#2dd4bf',
        accentInk: '#062a26',
        danger: '#f87171',
        warn: '#fbbf24',
        ok: '#34d399'
      }
    : {
        dark,
        bg: '#f3f5f8',
        card: '#ffffff',
        card2: '#eef1f5',
        border: '#dde2ea',
        text: '#151922',
        muted: '#5d6678',
        accent: '#0d9488',
        accentInk: '#ffffff',
        danger: '#dc2626',
        warn: '#d97706',
        ok: '#059669'
      }
}
