// Fechas de negocio en la zona horaria de la instalación (APP_TIMEZONE).
//
// Un "día" de kilometraje es un día de calendario en esa zona. Los
// proveedores trabajan en UTC, así que se convierte el día a su intervalo
// UTC real, respetando horario de verano si la zona lo tiene.
import { HttpError } from './http.ts'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function appTimeZone(): string {
  const tz = (Deno.env.get('APP_TIMEZONE') ?? '').trim()
  if (!tz || !isValidTimeZone(tz)) {
    throw new HttpError(500, 'Falta el secret APP_TIMEZONE o no es una zona horaria válida (p. ej. America/Mexico_City).')
  }
  return tz
}

export function isValidDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false
  const d = new Date(`${date}T00:00:00Z`)
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date
}

// Fecha YYYY-MM-DD de un instante visto desde la zona `tz`.
export function dateInTz(instant: Date, tz: string): string {
  return instant.toLocaleDateString('en-CA', { timeZone: tz })
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// Diferencia (ms) entre la hora local en `tz` y UTC en el instante dado.
function tzOffsetMs(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant)
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - instant.getTime()
}

// Instante UTC en que empieza (00:00:00 local) el día `date` en la zona `tz`.
export function startOfDayUtc(date: string, tz: string): Date {
  const naive = Date.parse(`${date}T00:00:00Z`)
  let t = naive - tzOffsetMs(new Date(naive), tz)
  // Segunda pasada: corrige si la primera estimación cayó del otro lado de un cambio de horario.
  t = naive - tzOffsetMs(new Date(t), tz)
  return new Date(t)
}

// Intervalo UTC [inicio, fin] (fin inclusivo, al segundo) del día `date` en `tz`.
export function dayRangeUtc(date: string, tz: string): { from: Date; to: Date } {
  const from = startOfDayUtc(date, tz)
  const to = new Date(startOfDayUtc(addDays(date, 1), tz).getTime() - 1000)
  return { from, to }
}

// Resuelve 'today' | 'yesterday' | 'YYYY-MM-DD' a una fecha en `tz`.
export function resolveDate(value: string | undefined, tz: string, now = new Date()): string {
  const today = dateInTz(now, tz)
  if (!value || value === 'yesterday') return addDays(today, -1)
  if (value === 'today') return today
  if (!isValidDate(value)) throw new HttpError(400, `Fecha inválida: ${value} (usa YYYY-MM-DD, "today" o "yesterday").`)
  return value
}

// Hora (0-23) de un instante vista desde la zona `tz`.
export function hourInTz(instant: Date, tz: string): number {
  const hour = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(instant)
    .find(p => p.type === 'hour')?.value
  return Number(hour)
}

// Días de calendario de `from` a `to` (YYYY-MM-DD). Negativo si `to` es anterior.
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

// Día de la semana ISO de una fecha YYYY-MM-DD: 1 = lunes … 7 = domingo.
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay()
  return d === 0 ? 7 : d
}
