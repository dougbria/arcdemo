import { defineConfig } from 'vite';
import { storageMiddleware } from './src/server-bridge.js';

export default defineConfig(({ command }) => ({
  plugins: [
    // Storage bridge middleware only used in dev — not included in production build
    ...(command === 'serve' ? [{
      name: 'storage-bridge',
      configureServer(server) {
        server.middlewares.use(storageMiddleware);
      }
    }] : [])
  ],
  server: {
    // Dev-only proxy: forwards /api → Bria's engine
    // In production, api.js switches API_BASE to the direct URL via import.meta.env.PROD
    proxy: {
      '/api': {
        target: 'https://engine.prod.bria-api.com/v2',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        secure: true
      }
    }
  },
  build: {
    outDir: 'dist',
    // Inline small assets to reduce requests
    assetsInlineLimit: 4096,
    // Source maps for easier debugging of production issues
    sourcemap: false,
    rollupOptions: {
      output: {
        // Clean chunk names for caching
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  },
  // If deploying to a GitHub Pages project page (not user/org root),
  // set base to your repo name: base: '/vgl-studio/'
  // For a user/org page (username.github.io), leave base as '/'
  base: '/arcdemo/'
}));
