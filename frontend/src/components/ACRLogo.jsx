export default function ACRLogo({ className = '', size = 32 }) {
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
      {/* Hexagonal shield */}
      <polygon
        points="32,4 58,18 58,46 32,60 6,46 6,18"
        fill="#1e3a5f"
        stroke="#2563eb"
        strokeWidth="2"
      />
      {/* Signal arcs */}
      <path d="M20 38 Q32 20 44 38" stroke="#60a5fa" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <path d="M24 42 Q32 28 40 42" stroke="#93c5fd" strokeWidth="2" fill="none" strokeLinecap="round" />
      {/* Center dot */}
      <circle cx="32" cy="44" r="2.5" fill="#3b82f6" />
      {/* A-frame top bar */}
      <path d="M22 52 L32 34 L42 52" stroke="#2563eb" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="26" y1="46" x2="38" y2="46" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
