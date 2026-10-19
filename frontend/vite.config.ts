import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // The backend's CORS setting (FRONTEND_URL) allows exactly this origin, so
    // fail clearly instead of silently moving to another port.
    port: 5173,
    strictPort: true,
  },
})
