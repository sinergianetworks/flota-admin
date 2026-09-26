// Armado puro del correo de recordatorios: asunto, HTML (estilos inline,
// compatible con clientes de correo) y versión de texto plano.
import type { ReminderItem, ReminderKind } from './reminders.ts'

export interface EmailOptions {
  appName: string
  appUrl: string
  today: string // YYYY-MM-DD
}

export interface EmailContent {
  subject: string
  html: string
  text: string
}

const KIND_LABEL: Record<ReminderKind, string> = {
  insurance: 'Seguro',
  maintenance_date: 'Mantenimiento (fecha)',
  maintenance_km: 'Mantenimiento (km)',
}

// Entero con separador de miles "." (no depende del ICU del runtime).
function int(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

function date(d: string): string {
  const [y, m, day] = d.split('-')
  return `${day}/${m}/${y}`
}

function days(n: number): string {
  return `${n} día${n === 1 ? '' : 's'}`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function describeItem(item: ReminderItem): string {
  if (item.kind === 'maintenance_km') {
    const due = int(item.dueKm ?? 0)
    if (item.remaining > 0) return `faltan ${int(item.remaining)} km (a los ${due} km)`
    if (item.remaining === 0) return `llegó a los ${due} km`
    return `pasado por ${int(-item.remaining)} km (tocaba a los ${due} km)`
  }
  const d = date(item.dueDate ?? '')
  if (item.remaining > 0) return `vence en ${days(item.remaining)} (${d})`
  if (item.remaining === 0) return `vence hoy (${d})`
  return `vencido hace ${days(-item.remaining)} (${d})`
}

function vehicleLabel(item: ReminderItem): string {
  return item.plate ? `${item.vehicleName} (${item.plate})` : item.vehicleName
}

function section(title: string, color: string, items: ReminderItem[]): string {
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

export function buildReminderEmail(items: ReminderItem[], opts: EmailOptions): EmailContent {
  const overdue = items.filter(i => i.overdue)
  const upcoming = items.filter(i => !i.overdue)
  const n = items.length
  const subject = n === 0
    ? `${opts.appName}: sin vencimientos — ${date(opts.today)}`
    : `${opts.appName}: ${n} vencimiento${n === 1 ? '' : 's'} — ${date(opts.today)}`
  const url = `${opts.appUrl.replace(/\/+$/, '')}/vehiculos`

  const body = n === 0
    ? '<p style="font-size:14px;color:#374151">No hay vencimientos para hoy.</p>'
    : section('Vencidos', '#dc2626', overdue) + section('Próximos', '#b45309', upcoming)

  const html = `<!doctype html>
<html lang="es"><body style="margin:0;padding:24px;background:#f9fafb;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">
    <h1 style="margin:0 0 4px;font-size:18px;color:#111827">${esc(opts.appName)}</h1>
    <p style="margin:0;font-size:13px;color:#6b7280">Vencimientos al ${date(opts.today)}</p>
    ${body}
    <p style="margin:24px 0">
      <a href="${esc(url)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">Abrir ${esc(opts.appName)}</a>
    </p>
    <p style="margin:0;font-size:12px;color:#9ca3af">Recibes este aviso porque eres administrador. Se repite cada día hasta que se actualice el dato en la app.</p>
  </div>
</body></html>`

  const lines = (title: string, list: ReminderItem[]) => list.length === 0 ? [] : [
    '', `${title} (${list.length})`,
    ...list.map(i => `- ${vehicleLabel(i)} · ${KIND_LABEL[i.kind]}: ${describeItem(i)}`),
  ]
  const text = [
    `${opts.appName} — vencimientos al ${date(opts.today)}`,
    ...(n === 0 ? ['', 'No hay vencimientos para hoy.'] : [...lines('VENCIDOS', overdue), ...lines('PRÓXIMOS', upcoming)]),
    '', `Abrir: ${url}`,
    '', 'Recibes este aviso porque eres administrador. Se repite cada día hasta que se actualice el dato en la app.',
  ].join('\n')

  return { subject, html, text }
}
