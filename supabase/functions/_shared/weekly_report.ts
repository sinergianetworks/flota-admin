// Cálculo puro del reporte semanal: una fila por vehículo activo más las
// alertas (mantenimiento con las reglas del diario y seguro).
import { addDays, daysBetween } from './time.ts'
import {
  averageKmPerDay, computeInsuranceAlerts, computeReminders, sortReminders,
  type OdometerRow, type ReminderItem, type ReminderSettings, type ReminderVehicle,
} from './reminders.ts'

export interface WeeklyVehicle extends ReminderVehicle {
  insurance_company: string | null
  gps_device_id: string | null
  driver: { full_name: string } | null
}

export interface MileageRow {
  vehicle_id: string
  date: string
  km: number | string
}

export type MaintenanceInfo =
  | { kind: 'km'; remainingKm: number }
  | { kind: 'km_unknown'; dueKm: number }
  | { kind: 'date'; remainingDays: number; date: string }
  | null

export interface WeeklyVehicleRow {
  vehicleId: string
  name: string
  plate: string | null
  driver: string | null
  odometerKm: number | null
  weekKm: number | null
  maintenance: MaintenanceInfo
  insurance: { expiry: string; remainingDays: number; company: string | null } | null
  alerts: ReminderItem[]
}

export interface WeeklyReport {
  periodFrom: string
  periodTo: string
  totals: { vehicles: number; weekKm: number; alerts: number }
  attention: ReminderItem[]
  rows: WeeklyVehicleRow[]
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function buildWeeklyReport(
  input: {
    vehicles: WeeklyVehicle[]
    odometers: OdometerRow[]
    // Debe cubrir de `today - 28` a `today - 1`: se usa tanto para los km de
    // la semana (últimos 7 días) como para el promedio de las estimaciones
    // (últimos 28 días, ver `averageKmPerDay`).
    mileage: MileageRow[]
  },
  settings: ReminderSettings,
  today: string,
): WeeklyReport {
  const periodFrom = addDays(today, -7)
  const periodTo = addDays(today, -1)
  const odoById = new Map(input.odometers.map(o => [o.vehicle_id, o]))

  const mileageByVehicle = new Map<string, { date: string; km: number }[]>()
  for (const m of input.mileage) {
    const km = Number(m.km)
    if (!Number.isFinite(km)) continue
    const list = mileageByVehicle.get(m.vehicle_id) ?? []
    list.push({ date: m.date, km })
    mileageByVehicle.set(m.vehicle_id, list)
  }
  const averages = new Map<string, number>()
  for (const [id, list] of mileageByVehicle) {
    const avg = averageKmPerDay(list, today)
    if (avg != null) averages.set(id, avg)
  }

  const rows: WeeklyVehicleRow[] = input.vehicles
    .filter(v => v.active)
    .map(v => {
      const odo = odoById.get(v.id)
      const hasOdo = !!odo?.has_data
      const maintenanceAlerts = computeReminders([v], input.odometers, settings, today, averages)
      const insuranceAlerts = computeInsuranceAlerts([v], settings, today)

      const dueKmNum = v.next_maintenance_km != null ? Number(v.next_maintenance_km) : null
      const hasDueKm = dueKmNum != null && dueKmNum > 0
      const km: MaintenanceInfo = hasDueKm && hasOdo
        ? { kind: 'km', remainingKm: Math.round(dueKmNum! - Number(odo!.odometer_km)) }
        : null
      const byDate: MaintenanceInfo = v.next_maintenance_date
        ? { kind: 'date', remainingDays: daysBetween(today, v.next_maintenance_date), date: v.next_maintenance_date }
        : null
      // Si hay km sin datos de odómetro (y no hay fecha), mostramos el km
      // objetivo con la marca de "sin odómetro" (ver weekly_email.ts).
      const kmUnknown: MaintenanceInfo = hasDueKm && !hasOdo && !byDate
        ? { kind: 'km_unknown', dueKm: Math.round(dueKmNum!) }
        : null
      const kmAlertItem = maintenanceAlerts.find(a => a.kind === 'maintenance_km')
      const dateAlertItem = maintenanceAlerts.find(a => a.kind === 'maintenance_date')
      const kmAlert = !!kmAlertItem
      const kmOverdue = !!kmAlertItem?.overdue
      const dateAlert = !!dateAlertItem
      const dateOverdue = byDate != null && byDate.kind === 'date' && byDate.remainingDays < 0
      // Con km y fecha, se prefiere la fecha cuando ella está en alerta (o
      // vencida) y el km no lo está; en el resto de los casos, el km. Sin
      // km (o sin odómetro), se usa la fecha; sin fecha, el km (o
      // "sin odómetro" si no hay lectura de odómetro).
      const showDateOverKm = (dateAlert && !kmAlert) || (dateOverdue && !kmOverdue)
      const maintenance = km && byDate ? (showDateOverKm ? byDate : km) : (km ?? byDate ?? kmUnknown)

      const week = mileageByVehicle.get(v.id) ?? []
      const weekKm = v.gps_device_id
        ? round2(week.filter(m => m.date >= periodFrom && m.date <= periodTo).reduce((s, m) => s + m.km, 0))
        : null

      return {
        vehicleId: v.id,
        name: v.name,
        plate: v.plate,
        driver: v.driver?.full_name ?? null,
        odometerKm: hasOdo ? Math.round(Number(odo!.odometer_km)) : null,
        weekKm,
        maintenance,
        insurance: v.insurance_expiry
          ? { expiry: v.insurance_expiry, remainingDays: daysBetween(today, v.insurance_expiry), company: v.insurance_company }
          : null,
        alerts: sortReminders([...maintenanceAlerts, ...insuranceAlerts]),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'es'))

  const attention = sortReminders(rows.flatMap(r => r.alerts))
  return {
    periodFrom,
    periodTo,
    totals: {
      vehicles: rows.length,
      weekKm: round2(rows.reduce((s, r) => s + (r.weekKm ?? 0), 0)),
      alerts: attention.length,
    },
    attention,
    rows,
  }
}
