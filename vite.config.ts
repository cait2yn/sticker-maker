import { defineConfig } from 'vite'

export default defineConfig({
  // onnxruntime-web (inside the background remover) breaks when pre-bundled
  optimizeDeps: { exclude: ['@imgly/background-removal'] },
  server: { port: 5302 },
})
