import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Forward /api to Express in development. The browser sees one origin,
    // so cookies just work and no API key or backend URL is exposed.
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
})
