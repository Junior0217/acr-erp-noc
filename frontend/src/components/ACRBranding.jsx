import ACRLogo from './ACRLogo'
import { useEmpresa } from '../contexts/EmpresaContext'

/**
 * Branding completo: logo + nombre comercial + eslogan
 * Todo viene del EmpresaContext (zero hardcode).
 *
 * Props:
 *   variant: 'compact' | 'full' | 'pdf'
 *   logoSize: tamaño px del logo
 */
export default function ACRBranding({ variant = 'compact', logoSize = 32, className = '' }) {
  const { empresa } = useEmpresa()
  const nombre  = empresa.nombreComercial ?? empresa.razonSocial
  const eslogan = empresa.eslogan

  if (variant === 'pdf') {
    return (
      <div className={`flex items-start gap-3 ${className}`}>
        <ACRLogo size={logoSize} />
        <div>
          <h1 className="text-[18px] font-extrabold text-slate-900 leading-tight uppercase">{empresa.razonSocial}</h1>
          {eslogan && <p className="text-[10px] text-slate-600 tracking-wide leading-snug">{eslogan}</p>}
        </div>
      </div>
    )
  }

  if (variant === 'full') {
    return (
      <div className={`flex items-center gap-3 ${className}`}>
        <ACRLogo size={logoSize} />
        <div>
          <p className="text-sm font-bold text-slate-100 leading-tight">{nombre}</p>
          {eslogan && <p className="text-[10px] text-slate-500 leading-tight">{eslogan}</p>}
        </div>
      </div>
    )
  }

  // compact: solo logo + nombre
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <ACRLogo size={logoSize} />
      <span className="text-sm font-bold text-slate-100">{nombre}</span>
    </div>
  )
}
