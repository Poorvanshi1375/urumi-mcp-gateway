import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In dev, the API and gateway run in k3d behind the Ingress; proxy them so the session cookie is
// same-origin, exactly as in production where Fastify serves this build.
const target = process.env.GATEWAY_URL ?? 'http://localhost:9080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { '/api': { target, changeOrigin: false }, '/mcp': { target } } },
  // assetsInlineLimit 0: never inline fonts/images as data: URIs, so the strict CSP
  // (font-src 'self', set by the platform) applies without exceptions.
  build: { outDir: 'dist', sourcemap: false, assetsInlineLimit: 0 },
});
