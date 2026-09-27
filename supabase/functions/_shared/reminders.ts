// Cálculos de mantenimiento y seguro compartidos por el correo diario y el
// reporte semanal. Sin estado: se recalcula cada día, así que un aviso deja
// de aparecer en cuanto el admin actualiza el dato en la app.
import { addDays, daysBetween } from './time.ts'

export interface ReminderSettings {
  maintenance_km_threshold: number
  maintenance_days_threshold: number
  insurance_days_threshold: number
}

export interface ReminderVehicle {
  id: string
  name: string
  plate: string | null
  active: boolean
  next_maintenance_km: number | string | null
  next_maintenance_date: string | null
  insurance_expiry: string | null
  gps_device_id?: string | null
}

export interface OdometerRow {
  vehicle_id: string
  odometer_km: number | string
  has_data: boolean
}

export type ReminderKind = 'insurance' | 'maintenance_date' | 'maintenance_km'

export interface ReminderItem {
  vehicleId: string
  vehicleName: string
  plate: string | null
  kind: ReminderKind
  overdue: boolean
  // km o días que faltan; negativo si ya venció
  remaining: number
  dueDate?: string
  dueKm?: number
  // días estimados hasta el mantenimiento por km (ritmo de los últimos 28 días)
  estimatedDays?: number
}

const KIND_ORDER: ReminderKind[] = ['insurance', 'maintenance_date', 'maintenance_km']

const AVG_WINDOW_DAYS = 28
const MIN_DAYS_WITH_DATA = 7
// Con un ritmo muy bajo, la estimación no es útil.
const MAX_ESTIMATE_DAYS = 365

// Promedio de km por día de los últimos 28 días completos (hoy excluido).
// Los días sin registro cuentan como 0 (el vehículo no se movió). Devuelve
// null si hay menos de 7 días con registro o si el promedio no es positivo.
export function averageKmPerDay(rows: { date: string; km: number | string }[], today: string): number | null {
  const from = addDays(today, -AVG_WINDOW_DAYS)
  const inRange = rows.filter(r => r.date >= from && r.date < today)
  const days = new Set(inRange.map(r => r.date))
  if (days.size < MIN_DAYS_WITH_DATA) return null
  const avg = inRange.reduce((s, r) => s + Number(r.km), 0) / AVG_WINDOW_DAYS
  return avg > 0 ? avg : null
}

// Avisos de mantenimiento (por km y por fecha) de los vehículos activos.
// `avgKmPerDay` (opcional): promedio por vehículo para estimar los días.
export function computeReminders(
  vehicles: ReminderVehicle[],
  odometers: OdometerRow[],
  settings: ReminderSettings,
  today: string,
  avgKmPerDay: Map<string, number> = new Map(),
): ReminderItem[] {
  const odoById = new Map(odometers.map(o => [o.vehicle_id, o]))
  const items: ReminderItem[] = []

  for (const v of vehicles) {
    if (!v.active) continue
    const base = { vehicleId: v.id, vehicleName: v.name, plate: v.plate }

    if (v.next_maintenance_km != null) {
      const odo = odoById.get(v.id)
      const dueKm = Number(v.next_maintenance_km)
      if (odo?.has_data && Number.isFinite(dueKm) && dueKm > 0) {
        const remaining = Math.round(dueKm - Number(odo.odometer_km))
        if (remaining <= settings.maintenance_km_threshold) {
          const overdue = remaining <= 0
          const avg = avgKmPerDay.get(v.id)
          const item: ReminderItem = { ...base, kind: 'maintenance_km', remaining, overdue, dueKm }
          if (!overdue && v.gps_device_id && avg != null && avg > 0) {
            const estimatedDays = Math.ceil(remaining / avg)
            if (estimatedDays <= MAX_ESTIMATE_DAYS) item.estimatedDays = estimatedDays
          }
          items.push(item)
        }
      }
    }

    if (v.next_maintenance_date) {
      const remaining = daysBetween(today, v.next_maintenance_date)
      if (remaining <= settings.maintenance_days_threshold) {
        items.push({ ...base, kind: 'maintenance_date', remaining, overdue: remaining < 0, dueDate: v.next_maintenance_date })
      }
    }
  }

  return sortReminders(items)
}

// Avisos de seguro (vence hoy = vencido). Los usa el reporte semanal.
export function computeInsuranceAlerts(vehicles: ReminderVehicle[], settings: ReminderSettings, today: string): ReminderItem[] {
  const items: ReminderItem[] = []
  for (const v of vehicles) {
    if (!v.active || !v.insurance_expiry) continue
    const remaining = daysBetween(today, v.insurance_expiry)
    if (remaining <= settings.insurance_days_threshold) {
      items.push({ vehicleId: v.id, vehicleName: v.name, plate: v.plate, kind: 'insurance', remaining, overdue: remaining <= 0, dueDate: v.insurance_expiry })
    }
  }
  return sortReminders(items)
}

// Vencidos primero; dentro de cada grupo, por tipo (seguro, fecha, km), del más
// urgente al menos, y por nombre del vehículo.
export function sortReminders(items: ReminderItem[]): ReminderItem[] {
  return [...items].sort((a, b) =>
    Number(b.overdue) - Number(a.overdue)
    || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    || a.remaining - b.remaining
    || a.vehicleName.localeCompare(b.vehicleName, 'es'))
}
