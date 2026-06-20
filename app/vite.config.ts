import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Pinned so the Google OAuth redirect URI / Enoki origin stays stable across restarts.
  server: { port: 5174, strictPort: true },
});
