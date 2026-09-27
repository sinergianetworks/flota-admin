// Helpers de formato compartidos por los correos (diario y semanal).
import type { ReminderItem, ReminderKind } from './reminders.ts'

export const KIND_LABEL: Record<ReminderKind, string> = {
  insurance: 'Seguro',
  maintenance_date: 'Mantenimiento (fecha)',
  maintenance_km: 'Mantenimiento (km)',
}

// Entero con separador de miles "." (no depende del ICU del runtime).
export function int(n: number): string {
  const s = Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return n < 0 && Math.round(Math.abs(n)) !== 0 ? `-${s}` : s
}

// "2026-09-26" → "26/09/2026"
export function date(d: string): string {
  const [y, m, day] = d.split('-')
  return `${day}/${m}/${y}`
}

// "2026-09-26" → "26/09"
export function shortDate(d: string): string {
  const [, m, day] = d.split('-')
  return `${day}/${m}`
}

export function days(n: number): string {
  return `${n} día${n === 1 ? '' : 's'}`
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function describeItem(item: ReminderItem): string {
  if (item.kind === 'maintenance_km') {
    const due = int(item.dueKm ?? 0)
    if (item.remaining > 0) {
      return item.estimatedDays != null
        ? `faltan ${int(item.remaining)} km (≈ ${days(item.estimatedDays)} al ritmo actual; a los ${due} km)`
        : `faltan ${int(item.remaining)} km (a los ${due} km)`
    }
    if (item.remaining === 0) return `llegó a los ${due} km`
    return `pasado por ${int(-item.remaining)} km (tocaba a los ${due} km)`
  }
  const d = date(item.dueDate ?? '')
  if (item.remaining > 0) return `vence en ${days(item.remaining)} (${d})`
  if (item.remaining === 0) return `vence hoy (${d})`
  return `vencido hace ${days(-item.remaining)} (${d})`
}

export function vehicleLabel(item: { vehicleName: string; plate: string | null }): string {
  return item.plate ? `${item.vehicleName} (${item.plate})` : item.vehicleName
}

export const RED = '#dc2626'
export const AMBER = '#b45309'

// Tabla HTML de avisos con título (vacía si no hay avisos).
export function alertsSection(title: string, color: string, items: ReminderItem[]): string {
  if (items.length === 0) return ''
  const rows = items.map(i => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;color:#111827">${esc(vehicleLabel(i))}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#374151">${esc(KIND_LABEL[i.kind])}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:${color}">${esc(describeItem(i))}</td>
      </tr>`).join('')
  return `
    <h2 style="margin:24px 0 8px;font-size:16px;color:${color}">${title} (${items.length})</h2>
    <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:14px">${rows}
    </table>`
}

// Líneas de texto plano de un grupo de avisos.
export function alertsText(title: string, items: ReminderItem[]): string[] {
  return items.length === 0 ? [] : ['', `${title} (${items.length})`, ...items.map(i => `- ${vehicleLabel(i)} · ${KIND_LABEL[i.kind]}: ${describeItem(i)}`)]
}

// Envoltura HTML común (encabezado, cuerpo, botón y pie).
export function emailShell(o: { appName: string; subtitle: string; body: string; url: string; footer: string }): string {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:24px;background:#f9fafb;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">
    <h1 style="margin:0 0 4px;font-size:18px;color:#111827">${esc(o.appName)}</h1>
    <p style="margin:0;font-size:13px;color:#6b7280">${esc(o.subtitle)}</p>
    ${o.body}
    <p style="margin:24px 0">
      <a href="${esc(o.url)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">Abrir ${esc(o.appName)}</a>
    </p>
    <p style="margin:0;font-size:12px;color:#9ca3af">${esc(o.footer)}</p>
  </div>
</body></html>`
}

export function appLink(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}/vehiculos`
}
