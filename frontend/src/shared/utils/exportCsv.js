/**
 * Exports the current in-memory rows to CSV.
 * Never fetches from the server — only exports what's already on screen.
 * @param {string} filename
 * @param {{ header: string, getValue: (row: any) => string | number }[]} columns
 * @param {any[]} rows
 */
export function exportCsv(filename, columns, rows) {
  const esc = v => {
    const s = String(v ?? '')
    return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [
    columns.map(c => esc(c.header)).join(','),
    ...rows.map(row => columns.map(c => esc(c.getValue(row))).join(',')),
  ]
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = Object.assign(document.createElement('a'), { href: url, download: `${filename}.csv` })
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
