import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // GitHub Pages serves this project from https://<owner>.github.io/lrc-visualizer/.
  base: '/lrc-visualizer/',
  plugins: [react()],
})
