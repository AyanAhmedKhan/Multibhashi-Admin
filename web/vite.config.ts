import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

// Same origin as the API: /api is proxied to the AdonisJS server, so the session
// cookie is first-party and SameSite=Strict. In production nginx does the same.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:3500', xfwd: true },
    },
  },
})
