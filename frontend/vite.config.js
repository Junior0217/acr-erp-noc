import { defineConfig } from 'vite'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Vendor splitting — chunks separados con hash inmutable. Cambios en un panel
// no invalidan el cache de leaflet / dnd / pdf. Headers `immutable` en Vercel
// hacen que el browser sólo baje el delta del panel modificado.
function vendorChunk(id) {
  if (!id.includes('node_modules')) return undefined
  if (id.includes('react-router'))          return 'vendor-react-router'
  if (id.includes('react-dom') || /node_modules[\\/](react|scheduler)[\\/]/.test(id)) return 'vendor-react'
  if (id.includes('@dnd-kit'))              return 'vendor-dnd'
  if (id.includes('leaflet') || id.includes('react-leaflet')) return 'vendor-leaflet'
  if (id.includes('lucide-react'))          return 'vendor-icons'
  if (id.includes('sonner'))                return 'vendor-toast'
  if (id.includes('marked') || id.includes('react-to-print')) return 'vendor-pdf'
  return 'vendor'
}

export default defineConfig({
  resolve: {
    alias: {
      '@':         path.resolve(__dirname, 'src'),
      '@features': path.resolve(__dirname, 'src/features'),
      '@shared':   path.resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    target: 'es2020',
    cssCodeSplit: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: vendorChunk,
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      // autoUpdate: SW se actualiza solo cuando hay versión nueva (combinado con
      // skipWaiting + clientsClaim abajo). PWAUpdatePrompt sigue mostrando toast
      // pero el botón "Actualizar ahora" sólo confirma — la actualización ya
      // estaba descargándose en background.
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'masked-icon.svg'],
      manifest: {
        name: 'ACR Networks NOC',
        short_name: 'ACR NOC',
        description: 'Panel de Control NOC — ACR Networks & Solutions v2.1',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        cacheId: 'acr-noc-v3',
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        skipWaiting: true,
        clientsClaim: true,
        // Runtime caching strategy for API calls
        runtimeCaching: [
          {
            // Dashboard: network-first (fresh data preferred, cache as fallback)
            urlPattern: /\/api\/dashboard/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-dashboard',
              expiration: { maxEntries: 1, maxAgeSeconds: 60 },
              networkTimeoutSeconds: 5,
            },
          },
          {
            // Catalog / CRM lists: stale-while-revalidate (fast + eventual fresh)
            urlPattern: /\/api\/(catalogo|clientes|productos)/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'api-lists',
              expiration: { maxEntries: 20, maxAgeSeconds: 300 },
            },
          },
        ],
      },
      // Dev mode: show SW in dev server for testing install prompt
      devOptions: {
        enabled: false,
      },
    }),
  ],
})
