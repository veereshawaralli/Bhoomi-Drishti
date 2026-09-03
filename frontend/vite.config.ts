import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// The frontend talks to the FastAPI backend through /api. In dev, Vite proxies
// those calls so there is no CORS configuration to worry about.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirrors the "@/*" -> "src/*" mapping in tsconfig.json, so an import that
    // typechecks also resolves at build time.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      '/uploads': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
