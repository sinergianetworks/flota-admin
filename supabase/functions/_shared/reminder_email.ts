// Correo diario de alertas de mantenimiento: asunto, HTML y texto plano.
import type { ReminderItem } from './reminders.ts'
import { alertsSection, alertsText, appLink, date, emailShell, RED, AMBER } from './email_format.ts'

export { describeItem } from './email_format.ts'

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

const FOOTER = 'Recibes este aviso porque estás en la lista de avisos de la flota. Se repite cada día hasta que se actualice el mantenimiento en la app.'

export function buildReminderEmail(items: ReminderItem[], opts: EmailOptions): EmailContent {
  const overdue = items.filter(i => i.overdue)
  const upcoming = items.filter(i => !i.overdue)
  const n = items.length
  const subject = n === 0
    ? `${opts.appName}: sin alertas de mantenimiento — ${date(opts.today)}`
    : `${opts.appName}: ${n} alerta${n === 1 ? '' : 's'} de mantenimiento — ${date(opts.today)}`
  const url = appLink(opts.appUrl)

  const body = n === 0
    ? '<p style="font-size:14px;color:#374151">No hay mantenimientos por vencer.</p>'
    : alertsSection('Vencidos', RED, overdue) + alertsSection('Próximos', AMBER, upcoming)

  const html = emailShell({ appName: opts.appName, subtitle: `Mantenimientos al ${date(opts.today)}`, body, url, footer: FOOTER })

  const text = [
    `${opts.appName} — mantenimientos al ${date(opts.today)}`,
    ...(n === 0 ? ['', 'No hay mantenimientos por vencer.'] : [...alertsText('VENCIDOS', overdue), ...alertsText('PRÓXIMOS', upcoming)]),
    '', `Abrir: ${url}`,
    '', FOOTER,
  ].join('\n')

  return { subject, html, text }
}
