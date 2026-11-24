import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// electron-vite compila tres "mundos" separados:
//  main     -> src/main/index.js      (Node: red + disco)
//  preload  -> src/preload/index.js   (puente seguro)
//  renderer -> src/renderer/index.html (React, sin Node)
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()] }
})
