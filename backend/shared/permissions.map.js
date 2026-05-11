module.exports = [
  // ── Sistema ───────────────────────────────────────────────────────────────────
  { key: 'sistema:admin',           module: 'Sistema',       label: 'Administración',   desc: 'Config, usuarios, permisos',                  color: 'red'     },

  // ── Dashboard ─────────────────────────────────────────────────────────────────
  { key: 'dashboard:ver',           module: 'Dashboard',     label: 'Ver',              desc: 'KPIs y métricas generales',                    color: 'blue'    },

  // ── Inventario ────────────────────────────────────────────────────────────────
  { key: 'inventario:ver',          module: 'Inventario',    label: 'Ver',              desc: 'Listar productos y categorías',                 color: 'cyan'    },
  { key: 'inventario:editar',       module: 'Inventario',    label: 'Editar',           desc: 'Crear y modificar productos',                   color: 'cyan'    },
  { key: 'inventario:borrar',       module: 'Inventario',    label: 'Borrar',           desc: 'Eliminar productos (irreversible)',              color: 'cyan'    },
  { key: 'inventario:exportar',     module: 'Inventario',    label: 'Exportar CSV',     desc: 'Descargar inventario en CSV',                   color: 'cyan'    },
  { key: 'inventario:kardex',       module: 'Inventario',    label: 'Kardex',           desc: 'Ver movimientos de stock',                      color: 'cyan'    },

  // ── Servicios ISP ─────────────────────────────────────────────────────────────
  { key: 'servicios:ver',           module: 'Servicios',     label: 'Ver',              desc: 'Planes, contratos, órdenes ISP',                color: 'violet'  },
  { key: 'servicios:crear',         module: 'Servicios',     label: 'Crear',            desc: 'Nuevas órdenes de instalación',                 color: 'violet'  },

  // ── Catálogo de Items ─────────────────────────────────────────────────────────
  { key: 'catalogo:ver',            module: 'Catálogo',      label: 'Ver',              desc: 'Consultar items y precios del catálogo',        color: 'blue'    },
  { key: 'catalogo:ver_costos',     module: 'Catálogo',      label: 'Ver Costos',       desc: 'Ver columna Costo y Margen (confidencial)',     color: 'blue'    },
  { key: 'catalogo:editar',         module: 'Catálogo',      label: 'Editar',           desc: 'Crear y modificar items del catálogo',          color: 'blue'    },
  { key: 'catalogo:editar_precios', module: 'Catálogo',      label: 'Editar Precios',   desc: 'Modificar precios de venta (solo gerencia)',    color: 'blue'    },

  // ── Órdenes de Trabajo ────────────────────────────────────────────────────────
  { key: 'ot:ver',                  module: 'Órd. Trabajo',  label: 'Ver',              desc: 'Ver OTs asignadas o todas según rol',           color: 'violet'  },
  { key: 'ot:crear',                module: 'Órd. Trabajo',  label: 'Crear',            desc: 'Abrir nueva orden de trabajo desde CRM',        color: 'violet'  },
  { key: 'ot:editar',               module: 'Órd. Trabajo',  label: 'Editar',           desc: 'Actualizar diagnóstico, notas y detalles',      color: 'violet'  },
  { key: 'ot:cerrar',               module: 'Órd. Trabajo',  label: 'Cerrar',           desc: 'Marcar OT como completada (genera factura)',    color: 'violet'  },
  { key: 'ot:asignar',              module: 'Órd. Trabajo',  label: 'Asignar Técnico',  desc: 'Cambiar técnico asignado a la OT',              color: 'violet'  },

  // ── Facturación ───────────────────────────────────────────────────────────────
  { key: 'factura:ver',             module: 'Facturación',   label: 'Ver',              desc: 'Consultar facturas y estado NCF',               color: 'amber'   },
  { key: 'factura:emitir',          module: 'Facturación',   label: 'Emitir',           desc: 'Convertir borrador en factura oficial',         color: 'amber'   },
  { key: 'factura:anular',          module: 'Facturación',   label: 'Anular',           desc: 'Anular factura emitida (irreversible)',          color: 'amber'   },
  { key: 'factura:exportar',        module: 'Facturación',   label: 'Exportar',         desc: 'Descargar facturas en PDF o CSV',               color: 'amber'   },

  // ── CRM ───────────────────────────────────────────────────────────────────────
  { key: 'crm:ver',                 module: 'CRM',           label: 'Ver',              desc: 'Clientes, suplidores, prospectos',               color: 'emerald' },
  { key: 'crm:crear',               module: 'CRM',           label: 'Crear/Editar',     desc: 'Alta y modificación de clientes',               color: 'emerald' },
  { key: 'crm:borrar',              module: 'CRM',           label: 'Borrar',           desc: 'Eliminar clientes (irreversible)',               color: 'emerald' },
  { key: 'crm:exportar',            module: 'CRM',           label: 'Exportar CSV',     desc: 'Descarga de datos CRM',                         color: 'emerald' },
  { key: 'crm:editar_email',        module: 'CRM',           label: 'Editar Email',     desc: 'Modificar emails de contacto',                  color: 'emerald' },

  // ── RRHH ──────────────────────────────────────────────────────────────────────
  { key: 'rrhh:ver',                module: 'RRHH',          label: 'Ver',              desc: 'Técnicos y registros de RRHH',                  color: 'sky'     },
  { key: 'rrhh:asistencia',         module: 'RRHH',          label: 'Asistencia',       desc: 'Marcar entrada y salida',                       color: 'sky'     },
  { key: 'rrhh:config_seguridad',   module: 'RRHH',          label: 'Config Seguridad', desc: 'Configuración avanzada de RRHH',                color: 'sky'     },

  // ── Reportes ──────────────────────────────────────────────────────────────────
  { key: 'reportes:ver',            module: 'Reportes',      label: 'Ver',              desc: 'Módulo de reportes y KPIs',                     color: 'teal'    },
  { key: 'reportes:exportar',       module: 'Reportes',      label: 'Exportar',         desc: 'Reportes financieros y operativos',             color: 'teal'    },

  // ── Mapa NOC ──────────────────────────────────────────────────────────────────
  { key: 'mapa:ver',                module: 'Mapa NOC',      label: 'Ver Mapa',         desc: 'Mapa de infraestructura',                       color: 'teal'    },
]
