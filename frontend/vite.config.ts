import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    // In development the browser talks to Vite (port 5173) only. Vite forwards
    // anything under /api to the backend. In production Caddy does exactly the
    // same job, so the frontend code never needs to know where the API lives.
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
