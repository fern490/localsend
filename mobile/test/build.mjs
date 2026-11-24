// Compila la prueba reemplazando Expo por simulaciones en Node.
// Requiere: npm i -D esbuild ws   (en la carpeta mobile/)
import { build } from 'esbuild'
import path from 'node:path'
const here = path.dirname(new URL(import.meta.url).pathname)
await build({
  entryPoints: [path.join(here, 'mobile.test.mjs')],
  bundle: true, platform: 'node', format: 'esm', outfile: path.join(here, 'out/mobile.test.mjs'), banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
  plugins: [{ name: 'mocks', setup(b) {
    b.onResolve({ filter: /^expo-file-system$/ }, () => ({ path: path.join(here, 'mock-fs.js') }))
    b.onResolve({ filter: /localsend-native$/ }, () => ({ path: path.join(here, 'mock-native.js') }))
  } }]
})
