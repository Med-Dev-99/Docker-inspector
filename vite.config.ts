import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 4000, target: 'chrome120' },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7781', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:7781', ws: true, changeOrigin: true },
    },
  },
});
