// Correo del reporte semanal: resumen, alertas y tabla de todos los vehículos.
import type { EmailContent } from './reminder_email.ts'
import type { WeeklyReport, WeeklyVehicleRow } from './weekly_report.ts'
import type { ReminderKind } from './reminders.ts'
import { alertsSection, alertsText, appLink, date, days, emailShell, esc, int, shortDate, AMBER, RED } from './email_format.ts'

const WEEKDAYS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo']

export interface WeeklyEmailOptions {
  appName: string
  appUrl: string
  weekday: number // 1 = lunes … 7 = domingo
}

function tone(row: WeeklyVehicleRow, kind: ReminderKind): string {
  const alert = row.alerts.find(a => a.kind === kind)
  if (!alert) return '#374151'
  return alert.overdue ? RED : AMBER
}

function maintenanceText(row: WeeklyVehicleRow): { text: string; color: string } {
  const m = row.maintenance
  if (!m) return { text: '—', color: '#9ca3af' }
  if (m.kind === 'km_unknown') return { text: `a los ${int(m.dueKm)} km (sin odómetro)`, color: '#9ca3af' }
  if (m.kind === 'km') {
    const text = m.remainingKm > 0 ? `faltan ${int(m.remainingKm)} km` : m.remainingKm === 0 ? 'llegó al km' : `pasado por ${int(-m.remainingKm)} km`
    return { text, color: tone(row, 'maintenance_km') }
  }
  const text = m.remainingDays > 0 ? `en ${days(m.remainingDays)} (${date(m.date)})` : m.remainingDays === 0 ? `hoy (${date(m.date)})` : `vencido hace ${days(-m.remainingDays)} (${date(m.date)})`
  return { text, color: tone(row, 'maintenance_date') }
}

function insuranceText(row: WeeklyVehicleRow): { text: string; color: string } {
  const i = row.insurance
  if (!i) return { text: '—', color: '#9ca3af' }
  const d = date(i.expiry)
  const text = i.remainingDays > 0 ? `vence en ${days(i.remainingDays)} (${d})` : i.remainingDays === 0 ? `vence hoy (${d})` : `vencido hace ${days(-i.remainingDays)} (${d})`
  return { text, color: tone(row, 'insurance') }
}

// Texto plano del seguro, con la aseguradora entre paréntesis si está.
function insuranceTextPlain(row: WeeklyVehicleRow): string {
  const t = insuranceText(row).text
  const company = row.insurance?.company
  return company ? `${t} (${company})` : t
}

// Celda "Vehículo": nombre, luego placa/conductor y odómetro/km de la semana.
function vehicleCell(row: WeeklyVehicleRow): string {
  const meta = [row.plate, row.driver].filter((v): v is string => !!v).map(esc).join(' · ')
  const odo = row.odometerKm != null ? `${int(row.odometerKm)} km` : '—'
  const week = row.weekKm != null ? `${int(row.weekKm)} km` : 'sin GPS'
  return `<div style="font-weight:600;color:#111827">${esc(row.name)}</div>`
    + (meta ? `<div style="font-size:12px;color:#6b7280">${meta}</div>` : '')
    + `<div style="font-size:12px;color:#6b7280">Odómetro ${odo} · semana ${week}</div>`
}

// Celda "Seguro": vencimiento, luego la aseguradora si está.
function insuranceCell(row: WeeklyVehicleRow): string {
  const i = row.insurance
  if (!i) return `<span style="color:#9ca3af">—</span>`
  const t = insuranceText(row)
  const company = i.company ? `<div style="font-size:12px;color:#6b7280">${esc(i.company)}</div>` : ''
  return `<span style="color:${t.color}">${esc(t.text)}</span>${company}`
}

const TH = 'padding:8px 10px;border-bottom:2px solid #e5e7eb;text-align:left;font-size:12px;color:#6b7280;font-weight:600'
const TD = 'padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;vertical-align:top'

export function buildWeeklyEmail(report: WeeklyReport, opts: WeeklyEmailOptions): EmailContent {
  const period = `${shortDate(report.periodFrom)} al ${date(report.periodTo)}`
  const subject = `${opts.appName}: reporte semanal — ${period}`
  const url = appLink(opts.appUrl)
  const weekday = WEEKDAYS[(opts.weekday - 1 + 7) % 7]
  const footer = `Reporte semanal de la flota. Se envía cada ${weekday} a la lista de avisos.`
  const overdue = report.attention.filter(i => i.overdue)
  const upcoming = report.attention.filter(i => !i.overdue)

  const summary = `
    <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;margin-top:16px;border-collapse:collapse">
      <tr>
        <td style="padding:12px;background:#f3f4f6;border-radius:8px;text-align:center"><div style="font-size:20px;font-weight:700;color:#111827">${report.totals.vehicles}</div><div style="font-size:12px;color:#6b7280">vehículos activos</div></td>
        <td style="width:8px"></td>
        <td style="padding:12px;background:#f3f4f6;border-radius:8px;text-align:center"><div style="font-size:20px;font-weight:700;color:#111827">${int(report.totals.weekKm)} km</div><div style="font-size:12px;color:#6b7280">recorridos en la semana</div></td>
        <td style="width:8px"></td>
        <td style="padding:12px;background:#f3f4f6;border-radius:8px;text-align:center"><div style="font-size:20px;font-weight:700;color:${report.totals.alerts > 0 ? RED : '#111827'}">${report.totals.alerts}</div><div style="font-size:12px;color:#6b7280">alertas</div></td>
      </tr>
    </table>`

  const attention = report.attention.length === 0
    ? '<h2 style="margin:24px 0 8px;font-size:16px;color:#111827">Requieren atención</h2><p style="font-size:14px;color:#374151">Sin alertas esta semana.</p>'
    : '<h2 style="margin:24px 0 0;font-size:16px;color:#111827">Requieren atención</h2>' + alertsSection('Vencidos', RED, overdue) + alertsSection('Próximos', AMBER, upcoming)

  const rows = report.rows.map(r => {
    const m = maintenanceText(r)
    return `
      <tr>
        <td style="${TD}">${vehicleCell(r)}</td>
        <td style="${TD};color:${m.color}">${esc(m.text)}</td>
        <td style="${TD}">${insuranceCell(r)}</td>
      </tr>`
  }).join('')

  const table = `
    <h2 style="margin:24px 0 8px;font-size:16px;color:#111827">Vehículos</h2>
    <table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse">
      <tr><th style="${TH}">Vehículo</th><th style="${TH}">Próx. mantenimiento</th><th style="${TH}">Seguro</th></tr>${rows}
    </table>`

  const html = emailShell({ appName: opts.appName, subtitle: `Reporte semanal · ${period}`, body: summary + attention + table, url, footer })

  const text = [
    `${opts.appName} — reporte semanal ${period}`,
    '',
    `Vehículos activos: ${report.totals.vehicles} · Km de la flota: ${int(report.totals.weekKm)} km · Alertas: ${report.totals.alerts}`,
    ...(report.attention.length === 0 ? ['', 'Sin alertas esta semana.'] : [...alertsText('VENCIDOS', overdue), ...alertsText('PRÓXIMOS', upcoming)]),
    '', 'VEHÍCULOS',
    ...report.rows.map(r => {
      const label = r.plate ? `${r.name} (${r.plate})` : r.name
      const odo = r.odometerKm != null ? `${int(r.odometerKm)} km` : '—'
      const week = r.weekKm != null ? `semana ${int(r.weekKm)} km` : 'sin GPS'
      return `- ${label} · ${r.driver ?? '—'} · ${odo} · ${week} · mant.: ${maintenanceText(r).text} · seguro: ${insuranceTextPlain(r)}`
    }),
    '', `Abrir: ${url}`,
    '', footer,
  ].join('\n')

  return { subject, html, text }
}
