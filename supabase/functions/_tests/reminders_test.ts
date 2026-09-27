import { assertEquals } from 'jsr:@std/assert@1'
import { computeReminders, averageKmPerDay, computeInsuranceAlerts, sortReminders, type ReminderVehicle } from '../_shared/reminders.ts'

const S = { maintenance_km_threshold: 2000, maintenance_days_threshold: 15, insurance_days_threshold: 30 }
const TODAY = '2026-09-26'

function v(p: Partial<ReminderVehicle> & { id: string }): ReminderVehicle {
  return {
    name: p.id, plate: null, active: true,
    next_maintenance_km: null, next_maintenance_date: null, insurance_expiry: null,
    ...p,
  }
}
const odo = (vehicle_id: string, odometer_km: number, has_data = true) => ({ vehicle_id, odometer_km, has_data })

Deno.test('mantenimiento por km: en el límite avisa, un km más no', () => {
  const items = computeReminders(
    [v({ id: 'a', next_maintenance_km: 12000 }), v({ id: 'b', next_maintenance_km: 12001 })],
    [odo('a', 10000), odo('b', 10000)], S, TODAY)
  assertEquals(items.map(i => [i.vehicleId, i.kind, i.remaining, i.overdue]), [['a', 'maintenance_km', 2000, false]])
})

Deno.test('mantenimiento por km: vencido cuando llega o se pasa', () => {
  const items = computeReminders(
    [v({ id: 'a', next_maintenance_km: 10000 }), v({ id: 'b', next_maintenance_km: 9500 })],
    [odo('a', 10000), odo('b', 10000)], S, TODAY)
  assertEquals(items.map(i => [i.vehicleId, i.remaining, i.overdue]), [['b', -500, true], ['a', 0, true]])
})

Deno.test('mantenimiento por km: sin odómetro no avisa', () => {
  const items = computeReminders([v({ id: 'a', next_maintenance_km: 100 })], [odo('a', 0, false)], S, TODAY)
  assertEquals(items, [])
})

Deno.test('mantenimiento por fecha: límite, vencido y hoy', () => {
  const items = computeReminders([
    v({ id: 'lim', next_maintenance_date: '2026-10-11' }),   // 15 días
    v({ id: 'fuera', next_maintenance_date: '2026-10-12' }), // 16 días
    v({ id: 'hoy', next_maintenance_date: '2026-09-26' }),
    v({ id: 'venc', next_maintenance_date: '2026-09-20' }),
  ], [], S, TODAY)
  assertEquals(items.map(i => [i.vehicleId, i.remaining, i.overdue]), [
    ['venc', -6, true],
    ['hoy', 0, false],
    ['lim', 15, false],
  ])
})

Deno.test('vehículos inactivos no avisan', () => {
  const items = computeReminders([
    v({ id: 'a', active: false, next_maintenance_date: '2026-09-01' }),
    v({ id: 'b', active: false, next_maintenance_km: 9500 }),
  ], [odo('b', 10000)], S, TODAY)
  assertEquals(items, [])
})

Deno.test('mantenimiento por km: redondea a entero (strings incluidos)', () => {
  const items = computeReminders(
    [v({ id: 'a', next_maintenance_km: '10000' })],
    [{ vehicle_id: 'a', odometer_km: '9999.7', has_data: true }], S, TODAY)
  assertEquals(items.map(i => [i.remaining, i.overdue]), [[0, true]])
})

Deno.test('mantenimiento por km: redondea hacia arriba cuando faltan 0,6 km', () => {
  const items = computeReminders(
    [v({ id: 'a', next_maintenance_km: '10000' })],
    [{ vehicle_id: 'a', odometer_km: '9999.4', has_data: true }], S, TODAY)
  assertEquals(items.map(i => [i.remaining, i.overdue]), [[1, false]])
})

Deno.test('mantenimiento por km: next_maintenance_km 0 no avisa', () => {
  const items = computeReminders([v({ id: 'a', next_maintenance_km: 0 })], [odo('a', 0)], S, TODAY)
  assertEquals(items, [])
})

Deno.test('orden: mismo remaining y mismo tipo, por nombre', () => {
  const items = computeReminders([
    v({ id: 'z', name: 'Zeta', next_maintenance_date: '2026-09-27' }),
    v({ id: 'a', name: 'Alfa', next_maintenance_date: '2026-09-27' }),
  ], [], S, TODAY)
  assertEquals(items.map(i => i.vehicleId), ['a', 'z'])
})

Deno.test('computeReminders ya no incluye el seguro', () => {
  const items = computeReminders([v({ id: 'a', insurance_expiry: '2026-09-01' })], [], S, TODAY)
  assertEquals(items, [])
})

Deno.test('orden: vencidos primero; dentro de cada grupo, fecha antes que km y lo más urgente antes', () => {
  const items = computeReminders([
    v({ id: 'x', next_maintenance_km: 10500, next_maintenance_date: '2026-09-01' }),
    v({ id: 'y', next_maintenance_km: 9900 }),
  ], [odo('x', 10000), odo('y', 10000)], S, TODAY)
  assertEquals(items.map(i => [i.vehicleId, i.kind, i.overdue]), [
    ['x', 'maintenance_date', true],
    ['y', 'maintenance_km', true],
    ['x', 'maintenance_km', false],
  ])
})

Deno.test('computeInsuranceAlerts: vence hoy = vencido, umbral inclusivo', () => {
  const items = computeInsuranceAlerts([
    v({ id: 'hoy', insurance_expiry: '2026-09-26' }),
    v({ id: 'lim', insurance_expiry: '2026-10-26' }),
    v({ id: 'fuera', insurance_expiry: '2026-10-27' }),
    v({ id: 'inactivo', active: false, insurance_expiry: '2026-09-01' }),
  ], S, TODAY)
  assertEquals(items.map(i => [i.vehicleId, i.kind, i.remaining, i.overdue]), [
    ['hoy', 'insurance', 0, true],
    ['lim', 'insurance', 30, false],
  ])
})

Deno.test('sortReminders: seguro antes que mantenimiento dentro del mismo grupo', () => {
  const ins = computeInsuranceAlerts([v({ id: 's', insurance_expiry: '2026-09-20' })], S, TODAY)
  const mnt = computeReminders([v({ id: 'm', next_maintenance_date: '2026-09-20' })], [], S, TODAY)
  assertEquals(sortReminders([...mnt, ...ins]).map(i => i.kind), ['insurance', 'maintenance_date'])
})

Deno.test('averageKmPerDay: 28 días, los días sin registro cuentan como 0', () => {
  const rows = Array.from({ length: 14 }, (_, i) => ({ date: `2026-09-${String(12 + i).padStart(2, '0')}`, km: 56 }))
  assertEquals(averageKmPerDay(rows, TODAY), 28) // 14 × 56 / 28
})

Deno.test('averageKmPerDay: menos de 7 días con registro → null; promedio 0 → null; ignora fuera de rango', () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ date: `2026-09-${String(20 + i).padStart(2, '0')}`, km: 100 }))
  assertEquals(averageKmPerDay(six, TODAY), null)
  const zeros = Array.from({ length: 10 }, (_, i) => ({ date: `2026-09-${String(10 + i).padStart(2, '0')}`, km: 0 }))
  assertEquals(averageKmPerDay(zeros, TODAY), null)
  const withToday = [...Array.from({ length: 7 }, (_, i) => ({ date: `2026-09-${String(19 + i).padStart(2, '0')}`, km: 28 })), { date: TODAY, km: 9999 }]
  assertEquals(averageKmPerDay(withToday, TODAY), 7) // 7 × 28 / 28; el día de hoy no cuenta
})

Deno.test('averageKmPerDay: 6 días con registro más el de hoy → null (hoy no cuenta)', () => {
  const rows = [...Array.from({ length: 6 }, (_, i) => ({ date: `2026-09-${String(19 + i).padStart(2, '0')}`, km: 50 })), { date: TODAY, km: 9999 }]
  assertEquals(averageKmPerDay(rows, TODAY), null)
})

Deno.test('estimatedDays en mantenimiento por km (redondeo hacia arriba), no en vencidos', () => {
  const avg = new Map([['a', 100], ['b', 100]])
  const items = computeReminders(
    [v({ id: 'a', next_maintenance_km: 10750, gps_device_id: '1' }), v({ id: 'b', next_maintenance_km: 9900, gps_device_id: '2' }), v({ id: 'c', next_maintenance_km: 10500, gps_device_id: '3' })],
    [odo('a', 10000), odo('b', 10000), odo('c', 10000)], S, TODAY, avg)
  const byId = Object.fromEntries(items.map(i => [i.vehicleId, i]))
  assertEquals(byId.a.estimatedDays, 8)       // 750 / 100 → 7,5 → 8
  assertEquals(byId.b.estimatedDays, undefined) // vencido
  assertEquals(byId.c.estimatedDays, undefined) // sin promedio
})

Deno.test('estimatedDays: sin asignar si supera MAX_ESTIMATE_DAYS (365)', () => {
  const avg = new Map([['a', 1]])
  const items = computeReminders(
    [v({ id: 'a', next_maintenance_km: 11500, gps_device_id: '1' })],
    [odo('a', 10000)], S, TODAY, avg)
  assertEquals(items[0].estimatedDays, undefined) // 1.500 km / 1 km/día = 1.500 días > 365
})

Deno.test('estimatedDays: sin asignar si el vehículo no tiene gps_device_id', () => {
  const avg = new Map([['a', 100]])
  const items = computeReminders(
    [v({ id: 'a', next_maintenance_km: 10750, gps_device_id: null })],
    [odo('a', 10000)], S, TODAY, avg)
  assertEquals(items[0].estimatedDays, undefined)
})
