// Cálculo puro de los avisos de vencimiento del día. Sin estado: se
// recalcula cada día, así que un aviso deja de aparecer en cuanto el admin
// actualiza el dato en la app.
import { daysBetween } from './time.ts'

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
}

const KIND_ORDER: ReminderKind[] = ['insurance', 'maintenance_date', 'maintenance_km']

export function computeReminders(
  vehicles: ReminderVehicle[],
  odometers: OdometerRow[],
  settings: ReminderSettings,
  today: string,
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
          items.push({ ...base, kind: 'maintenance_km', remaining, overdue: remaining <= 0, dueKm })
        }
      }
    }

    if (v.next_maintenance_date) {
      const remaining = daysBetween(today, v.next_maintenance_date)
      if (remaining <= settings.maintenance_days_threshold) {
        items.push({ ...base, kind: 'maintenance_date', remaining, overdue: remaining < 0, dueDate: v.next_maintenance_date })
      }
    }

    if (v.insurance_expiry) {
      const remaining = daysBetween(today, v.insurance_expiry)
      if (remaining <= settings.insurance_days_threshold) {
        items.push({ ...base, kind: 'insurance', remaining, overdue: remaining <= 0, dueDate: v.insurance_expiry })
      }
    }
  }

  // Vencidos primero; dentro de cada grupo, por tipo y del más urgente al menos.
  return items.sort((a, b) =>
    Number(b.overdue) - Number(a.overdue)
    || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    || a.remaining - b.remaining
    || a.vehicleName.localeCompare(b.vehicleName, 'es'))
}
