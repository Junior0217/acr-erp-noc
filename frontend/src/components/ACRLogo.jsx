const PNG_SRC = '/logo-acr.png'

function ACRSvg({ size, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="ACR Networks"
    >
      <polygon points="32,4 58,18 58,46 32,60 6,46 6,18" fill="#1e3a5f" stroke="#2563eb" strokeWidth="2" />
      <path d="M20 38 Q32 20 44 38" stroke="#60a5fa" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <path d="M24 42 Q32 28 40 42" stroke="#93c5fd" strokeWidth="2" fill="none" strokeLinecap="round" />
      <circle cx="32" cy="44" r="2.5" fill="#3b82f6" />
      <path d="M22 52 L32 34 L42 52" stroke="#2563eb" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="26" y1="46" x2="38" y2="46" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export default function ACRLogo({ className = '', size = 32, usePng = true }) {
  if (!usePng) return <ACRSvg size={size} className={className} />

  return (
    <img
      src={PNG_SRC}
      alt="ACR Networks"
      width={size}
      height={size}
      className={className}
      style={{ objectFit: 'contain' }}
      onError={e => {
        e.currentTarget.style.display = 'none'
        const svg = document.createElement('div')
        svg.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="ACR Networks"><polygon points="32,4 58,18 58,46 32,60 6,46 6,18" fill="#1e3a5f" stroke="#2563eb" stroke-width="2"/><path d="M20 38 Q32 20 44 38" stroke="#60a5fa" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M24 42 Q32 28 40 42" stroke="#93c5fd" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="32" cy="44" r="2.5" fill="#3b82f6"/><path d="M22 52 L32 34 L42 52" stroke="#2563eb" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><line x1="26" y1="46" x2="38" y2="46" stroke="#2563eb" stroke-width="2" stroke-linecap="round"/></svg>`
        e.currentTarget.parentNode?.insertBefore(svg.firstChild, e.currentTarget)
      }}
    />
  )
}
