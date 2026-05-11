import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Inject the service worker registration script automatically
      injectRegister: 'auto',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'masked-icon.svg'],
      manifest: {
        name: 'ACR Networks NOC',
        short_name: 'ACR NOC',
        description: 'Panel de Control NOC — ACR Networks & Solutions',
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
        // Cache all build artifacts
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
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
