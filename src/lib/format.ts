import { config } from './config'

const LOCALE = 'es'

export function formatKm(km: number, decimals = 0): string {
  return `${km.toLocaleString(LOCALE, { maximumFractionDigits: decimals })} km`
}

export function formatMoney(amount: number): string {
  return `${config.currency}${amount.toLocaleString(LOCALE, { maximumFractionDigits: 2 })}`
}

// Fecha YYYY-MM-DD de un instante en la zona horaria de la instalación.
export function dateInTz(d: Date = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: config.timezone })
}

// Suma n días a una fecha YYYY-MM-DD (aritmética de calendario, sin zona).
export function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// "2026-09-26" → "26/09"
export function shortDayLabel(dateStr: string): string {
  const [, m, d] = dateStr.split('-')
  return `${d}/${m}`
}

// "2026-09-26" → "26/09/2026"
export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  const [y, m, d] = dateStr.split('-')
  return `${d}/${m}/${y}`
}

export function getInitials(name?: string | null): string {
  if (!name) return '?'
  return name.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
}
