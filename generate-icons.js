'use strict';
// Run once: node generate-icons.js
// Reads frontend/public/logo-acr.png → generates PWA + Apple touch icons

const sharp = require('sharp')
const path  = require('path')

const SRC  = path.join(__dirname, 'frontend', 'public', 'logo-acr.png')
const DEST = path.join(__dirname, 'frontend', 'public')

const ICONS = [
  { name: 'pwa-192x192.png',       size: 192 },
  { name: 'pwa-512x512.png',       size: 512 },
  { name: 'apple-touch-icon.png',  size: 180 },
]

async function generate() {
  console.log(`\x1b[36m[PWA ICONS]\x1b[0m Source: ${SRC}`)
  for (const { name, size } of ICONS) {
    const out = path.join(DEST, name)
    await sharp(SRC)
      .resize(size, size, {
        fit:        'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toFile(out)
    console.log(`  \x1b[32m✓\x1b[0m ${name} (${size}×${size})`)
  }
  console.log('\x1b[36m[PWA ICONS]\x1b[0m Done.')
}

generate().catch(err => { console.error('[PWA ICONS] Error:', err.message); process.exit(1) })
