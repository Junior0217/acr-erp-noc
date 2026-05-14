import { forwardRef } from 'react'

const fmtDate = d => d ? new Date(d).toLocaleDateString('es-DO', { day: '2-digit', month: 'long', year: 'numeric' }) : '—'

const ConduceOrden = forwardRef(({ orden }, ref) => {
  if (!orden) return null
  const cliente = orden.servicio?.cliente
  const plan    = orden.servicio?.plan

  return (
    <div
      ref={ref}
      style={{ fontFamily: 'system-ui, sans-serif', color: '#0f172a', background: '#fff', padding: '40px', maxWidth: '700px', margin: '0 auto', fontSize: '13px', lineHeight: '1.5' }}
    >
      {/* Encabezado */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #0f172a', paddingBottom: '16px', marginBottom: '24px' }}>
        <div>
          <div style={{ fontSize: '20px', fontWeight: '800', letterSpacing: '-0.5px' }}>ACR Networks & Solutions</div>
          <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px' }}>Tel: (809) 000-0000 · info@acrnetworks.do · Santo Domingo, RD</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '10px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Conduce de {orden.tipo ?? 'Instalación'}</div>
          <div style={{ fontSize: '18px', fontWeight: '800', fontFamily: 'monospace', color: '#1e40af' }}>#{orden.id?.slice(0, 8).toUpperCase()}</div>
          <div style={{ fontSize: '11px', color: '#64748b' }}>{fmtDate(orden.createdAt)}</div>
        </div>
      </div>

      {/* Cliente + Servicio */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '24px' }}>
        <div>
          <div style={{ fontSize: '10px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' }}>Cliente</div>
          <div style={{ fontWeight: '700', fontSize: '14px' }}>{cliente?.razonSocial ?? '—'}</div>
          <div style={{ fontSize: '11px', color: '#64748b' }}>{cliente?.noCliente}</div>
          <div style={{ fontSize: '11px', color: '#475569', marginTop: '4px' }}>{orden.servicio?.direccionInstalacion ?? ''}</div>
          <div style={{ fontSize: '11px', color: '#64748b', fontFamily: 'monospace' }}>{cliente?.telefonoPrincipal}</div>
        </div>
        <div>
          <div style={{ fontSize: '10px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' }}>Plan / Servicio</div>
          <div style={{ fontWeight: '700', fontSize: '14px' }}>{plan?.nombre ?? '—'}</div>
          <div style={{ fontSize: '11px', color: '#64748b' }}>{plan?.tipo}</div>
          <div style={{ fontSize: '10px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '12px 0 6px' }}>Técnico Asignado</div>
          <div style={{ fontWeight: '600' }}>{orden.tecnico?.nombre ?? '—'}</div>
          <div style={{ fontSize: '11px', color: '#64748b' }}>{orden.tecnico?.cargo}</div>
        </div>
      </div>

      {/* Equipos */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '24px' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #0f172a' }}>
            <th style={{ textAlign: 'left', padding: '8px 4px', fontSize: '10px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em' }}>SKU</th>
            <th style={{ textAlign: 'left', padding: '8px 4px', fontSize: '10px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Equipo / Descripción</th>
            <th style={{ textAlign: 'right', padding: '8px 4px', fontSize: '10px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Cant.</th>
          </tr>
        </thead>
        <tbody>
          {(orden.detalles ?? []).length === 0 ? (
            <tr>
              <td colSpan={3} style={{ padding: '16px 4px', textAlign: 'center', color: '#94a3b8', fontStyle: 'italic' }}>Solo mano de obra — sin equipos</td>
            </tr>
          ) : (
            (orden.detalles ?? []).map((d, i) => (
              <tr key={i} style={{ borderBottom: '1px solid #e2e8f0' }}>
                <td style={{ padding: '8px 4px', fontFamily: 'monospace', fontSize: '11px', color: '#64748b' }}>{d.producto?.sku}</td>
                <td style={{ padding: '8px 4px', fontWeight: '600' }}>{d.producto?.nombre ?? '—'}</td>
                <td style={{ padding: '8px 4px', textAlign: 'right', fontWeight: '700', fontFamily: 'monospace' }}>{d.cantidad}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {/* Notas */}
      {orden.notas && (
        <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', marginBottom: '24px' }}>
          <div style={{ fontSize: '10px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '4px' }}>Notas / Observaciones</div>
          <div style={{ fontSize: '12px', color: '#334155' }}>{orden.notas}</div>
        </div>
      )}

      {/* Firmas */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '40px', marginTop: '48px', paddingTop: '16px', borderTop: '1px solid #cbd5e1' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ height: '40px', borderBottom: '1px solid #94a3b8', marginBottom: '8px' }} />
          <div style={{ fontSize: '11px', color: '#64748b' }}>Firma del Técnico</div>
          <div style={{ fontSize: '12px', fontWeight: '600', color: '#334155', marginTop: '2px' }}>{orden.tecnico?.nombre}</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ height: '40px', borderBottom: '1px solid #94a3b8', marginBottom: '8px' }} />
          <div style={{ fontSize: '11px', color: '#64748b' }}>Conforme — Firma del Cliente</div>
          <div style={{ fontSize: '12px', fontWeight: '600', color: '#334155', marginTop: '2px' }}>{cliente?.nombreContacto} {cliente?.apellidoContacto}</div>
        </div>
      </div>

      <div style={{ textAlign: 'center', fontSize: '10px', color: '#94a3b8', marginTop: '32px', borderTop: '1px solid #e2e8f0', paddingTop: '12px' }}>
        Documento de conformidad — ACR Networks & Solutions · {new Date().getFullYear()} · ID: {orden.id}
      </div>
    </div>
  )
})

ConduceOrden.displayName = 'ConduceOrden'
export default ConduceOrden
