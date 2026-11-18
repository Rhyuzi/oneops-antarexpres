import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Dev server proxies /api to the local Express proxy (server/index.js),
// which forwards requests to the SiCepat API without CORS issues.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
