module.exports = [
  // ── Sistema ───────────────────────────────────────────────────────────────────
  { key: 'sistema:admin',              module: 'Sistema',       label: 'Administración',        desc: 'Config, usuarios, permisos',                     color: 'red'     },

  // ── Dashboard ─────────────────────────────────────────────────────────────────
  { key: 'dashboard:ver',              module: 'Dashboard',     label: 'Ver',                   desc: 'KPIs y métricas generales',                      color: 'blue'    },

  // ── Inventario ────────────────────────────────────────────────────────────────
  { key: 'inventario:ver',             module: 'Inventario',    label: 'Ver',                   desc: 'Listar productos y categorías',                  color: 'cyan'    },
  { key: 'inventario:editar',          module: 'Inventario',    label: 'Editar',                desc: 'Crear y modificar productos',                    color: 'cyan'    },
  { key: 'inventario:borrar',          module: 'Inventario',    label: 'Borrar',                desc: 'Eliminar productos (irreversible)',               color: 'cyan'    },
  { key: 'inventario:exportar',        module: 'Inventario',    label: 'Exportar CSV',          desc: 'Descargar inventario en CSV',                    color: 'cyan'    },
  { key: 'inventario:kardex',          module: 'Inventario',    label: 'Kardex',                desc: 'Ver movimientos de stock',                       color: 'cyan'    },
  { key: 'inventario:ajustar',         module: 'Inventario',    label: 'Ajuste de Stock',       desc: 'Ajustes manuales de inventario',                 color: 'cyan'    },
  { key: 'inventario:ver_costos',      module: 'Inventario',    label: 'Ver Costos',            desc: 'Ver precio de costo (confidencial)',              color: 'cyan'    },
  { key: 'inventario:compras',         module: 'Inventario',    label: 'Recibir Compras',       desc: 'Recepcionar POs y actualizar stock',             color: 'cyan'    },

  // ── Servicios ISP ─────────────────────────────────────────────────────────────
  { key: 'servicios:ver',              module: 'Servicios',     label: 'Ver',                   desc: 'Planes, contratos, órdenes ISP',                 color: 'violet'  },
  { key: 'servicios:crear',            module: 'Servicios',     label: 'Crear',                 desc: 'Nuevas órdenes de instalación',                  color: 'violet'  },
  { key: 'servicios:editar',           module: 'Servicios',     label: 'Editar',                desc: 'Modificar dirección, plan y precio',             color: 'violet'  },
  { key: 'servicios:cancelar',         module: 'Servicios',     label: 'Cancelar/Suspender',    desc: 'Cambiar estado a Cancelado o Suspendido',        color: 'violet'  },
  { key: 'servicios:exportar',         module: 'Servicios',     label: 'Exportar',              desc: 'Exportar listado de servicios',                  color: 'violet'  },

  // ── Catálogo de Items ─────────────────────────────────────────────────────────
  { key: 'catalogo:ver',               module: 'Catálogo',      label: 'Ver',                   desc: 'Consultar items y precios del catálogo',         color: 'blue'    },
  { key: 'catalogo:ver_costos',        module: 'Catálogo',      label: 'Ver Costos',            desc: 'Ver columna Costo y Margen (confidencial)',      color: 'blue'    },
  { key: 'catalogo:editar',            module: 'Catálogo',      label: 'Editar',                desc: 'Crear y modificar items del catálogo',           color: 'blue'    },
  { key: 'catalogo:editar_precios',    module: 'Catálogo',      label: 'Editar Precios',        desc: 'Modificar precios de venta (solo gerencia)',     color: 'blue'    },

  // ── POS / Punto de Venta ──────────────────────────────────────────────────────
  { key: 'pos:ver',                    module: 'POS',           label: 'Acceder al POS',        desc: 'Abrir panel de punto de venta',                  color: 'orange'  },
  { key: 'pos:cotizar',                module: 'POS',           label: 'Crear Cotizaciones',    desc: 'Guardar cart como cotización',                   color: 'orange'  },
  { key: 'pos:facturar',               module: 'POS',           label: 'Generar Facturas',      desc: 'Emitir facturas desde el POS',                   color: 'orange'  },
  { key: 'pos:descuentos',             module: 'POS',           label: 'Aplicar Descuentos',    desc: 'Descuentos por línea y global en POS',           color: 'orange'  },
  { key: 'pos:ver_costos',             module: 'POS',           label: 'Ver Costos en POS',     desc: 'Columna Costo y Margen en pantalla POS',         color: 'orange'  },

  // ── Ventas / Cotizaciones ─────────────────────────────────────────────────────
  { key: 'venta:ver_cotizaciones',     module: 'Ventas',        label: 'Ver Cotizaciones',      desc: 'Consultar listado de cotizaciones',              color: 'amber'   },
  { key: 'venta:crear_cotizaciones',   module: 'Ventas',        label: 'Crear Cotizaciones',    desc: 'Guardar y editar cotizaciones',                  color: 'amber'   },
  { key: 'venta:editar_cotizaciones',  module: 'Ventas',        label: 'Editar Cotizaciones',   desc: 'Actualizar precios en cotización pendiente',     color: 'amber'   },
  { key: 'ventas:forzar_credito',      module: 'Ventas',        label: 'Forzar Crédito',        desc: 'Bypass límite de crédito al facturar (Owner only)', color: 'red'   },

  // ── Órdenes de Trabajo ────────────────────────────────────────────────────────
  { key: 'ot:ver',                     module: 'Órd. Trabajo',  label: 'Ver',                   desc: 'Ver OTs asignadas o todas según rol',            color: 'violet'  },
  { key: 'ot:crear',                   module: 'Órd. Trabajo',  label: 'Crear',                 desc: 'Abrir nueva orden de trabajo desde CRM',         color: 'violet'  },
  { key: 'ot:editar',                  module: 'Órd. Trabajo',  label: 'Editar',                desc: 'Actualizar diagnóstico, notas y detalles',       color: 'violet'  },
  { key: 'ot:cerrar',                  module: 'Órd. Trabajo',  label: 'Cerrar',                desc: 'Marcar OT como completada (genera factura)',     color: 'violet'  },
  { key: 'ot:asignar',                 module: 'Órd. Trabajo',  label: 'Asignar Técnico',       desc: 'Cambiar técnico asignado a la OT',               color: 'violet'  },

  // ── Facturación ───────────────────────────────────────────────────────────────
  { key: 'factura:ver',                module: 'Facturación',   label: 'Ver',                   desc: 'Consultar facturas y estado NCF',                color: 'amber'   },
  { key: 'factura:emitir',             module: 'Facturación',   label: 'Emitir',                desc: 'Convertir borrador en factura oficial',          color: 'amber'   },
  { key: 'factura:editar',             module: 'Facturación',   label: 'Editar Estado',         desc: 'Marcar factura como Pagada o Vencida',           color: 'amber'   },
  { key: 'factura:anular',             module: 'Facturación',   label: 'Anular',                desc: 'Anular factura emitida (irreversible)',           color: 'amber'   },
  { key: 'factura:exportar',           module: 'Facturación',   label: 'Exportar',              desc: 'Descargar facturas en PDF o CSV',                color: 'amber'   },

  // ── Compras ───────────────────────────────────────────────────────────────────
  { key: 'compras:ver',                module: 'Compras',       label: 'Ver',                   desc: 'Consultar órdenes de compra (POs)',              color: 'lime'    },
  { key: 'compras:crear',              module: 'Compras',       label: 'Crear PO',              desc: 'Crear nuevas órdenes de compra',                 color: 'lime'    },
  { key: 'compras:aprobar',            module: 'Compras',       label: 'Aprobar PO',            desc: 'Autorizar órden de compra (solo gerencia)',      color: 'lime'    },
  { key: 'compras:recibir',            module: 'Compras',       label: 'Recibir Mercancía',     desc: 'Confirmar recepción y actualizar Kardex',        color: 'lime'    },

  // ── Contabilidad ──────────────────────────────────────────────────────────────
  { key: 'contabilidad:ver',           module: 'Contabilidad',  label: 'Ver',                   desc: 'Consultar asientos y cuentas',                   color: 'rose'    },
  { key: 'contabilidad:cierres',       module: 'Contabilidad',  label: 'Cierres de Período',    desc: 'Ejecutar cierre mensual/anual',                  color: 'rose'    },
  { key: 'contabilidad:reportes',      module: 'Contabilidad',  label: 'Reportes Financieros',  desc: 'P&L, Balance, Flujo de caja',                   color: 'rose'    },

  // ── CRM ───────────────────────────────────────────────────────────────────────
  { key: 'crm:ver',                    module: 'CRM',           label: 'Ver',                   desc: 'Solo lectura: clientes, suplidores, prospectos',  color: 'emerald' },
  { key: 'crm:crear',                  module: 'CRM',           label: 'Crear',                 desc: 'Alta de nuevos registros (alias legacy de crm:editar)', color: 'emerald' },
  { key: 'crm:editar',                 module: 'CRM',           label: 'Editar',                desc: 'Modificar registros existentes (escritura completa)', color: 'emerald' },
  { key: 'crm:borrar',                 module: 'CRM',           label: 'Borrar',                desc: 'Eliminar clientes (irreversible)',                color: 'emerald' },
  { key: 'crm:exportar',               module: 'CRM',           label: 'Exportar CSV',          desc: 'Descarga de datos CRM',                          color: 'emerald' },
  { key: 'crm:editar_email',           module: 'CRM',           label: 'Editar Email',          desc: 'Modificar emails de contacto',                   color: 'emerald' },

  // ── RRHH ──────────────────────────────────────────────────────────────────────
  { key: 'rrhh:ver',                   module: 'RRHH',          label: 'Ver',                   desc: 'Técnicos y registros de RRHH',                   color: 'sky'     },
  { key: 'rrhh:asistencia',            module: 'RRHH',          label: 'Asistencia',            desc: 'Marcar entrada y salida',                        color: 'sky'     },
  { key: 'rrhh:config_seguridad',      module: 'RRHH',          label: 'Config Seguridad',      desc: 'Configuración avanzada de RRHH',                 color: 'sky'     },
  { key: 'rrhh:crear',                 module: 'RRHH',          label: 'Crear Empleados',       desc: 'Alta de nuevos empleados',                       color: 'sky'     },
  { key: 'rrhh:editar',                module: 'RRHH',          label: 'Editar Empleados',      desc: 'Modificar datos y roles de empleados',           color: 'sky'     },
  { key: 'rrhh:nomina',                module: 'RRHH',          label: 'Nómina',                desc: 'Consultar y procesar nómina (confidencial)',     color: 'sky'     },

  // ── Reportes ──────────────────────────────────────────────────────────────────
  { key: 'reportes:ver',               module: 'Reportes',      label: 'Ver',                   desc: 'Módulo de reportes y KPIs',                      color: 'teal'    },
  { key: 'reportes:exportar',          module: 'Reportes',      label: 'Exportar',              desc: 'Reportes financieros y operativos',              color: 'teal'    },

  // ── Mapa NOC ──────────────────────────────────────────────────────────────────
  { key: 'mapa:ver',                   module: 'Mapa NOC',      label: 'Ver Mapa',              desc: 'Mapa de infraestructura',                        color: 'teal'    },

  // ── Bóveda PAM (alta sensibilidad — requiere 2FA + cooldown) ──────────────────
  { key: 'vault:ver',                  module: 'Bóveda PAM',    label: 'Ver Bóveda',            desc: 'Listar credenciales sin descifrar',              color: 'red'     },
  { key: 'vault:editar',               module: 'Bóveda PAM',    label: 'Crear/Eliminar',        desc: 'Crear y eliminar credenciales cifradas',         color: 'red'     },
  { key: 'vault:reveal',               module: 'Bóveda PAM',    label: 'Revelar Password',      desc: 'Descifrar password (2FA + cooldown 30s + audit)',color: 'red'     },
]
