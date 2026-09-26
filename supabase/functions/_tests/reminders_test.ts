import { assertEquals } from 'jsr:@std/assert@1'
import { computeReminders, type ReminderVehicle } from '../_shared/reminders.ts'

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

Deno.test('seguro: vence hoy cuenta como vencido', () => {
  const items = computeReminders([
    v({ id: 'hoy', insurance_expiry: '2026-09-26' }),
    v({ id: 'lim', insurance_expiry: '2026-10-26' }),   // 30 días
    v({ id: 'fuera', insurance_expiry: '2026-10-27' }), // 31 días
  ], [], S, TODAY)
  assertEquals(items.map(i => [i.vehicleId, i.kind, i.remaining, i.overdue]), [
    ['hoy', 'insurance', 0, true],
    ['lim', 'insurance', 30, false],
  ])
})

Deno.test('vehículos inactivos no avisan', () => {
  const items = computeReminders([v({ id: 'a', active: false, insurance_expiry: '2026-09-01' })], [], S, TODAY)
  assertEquals(items, [])
})

Deno.test('mantenimiento por km: redondea a entero (strings incluidos)', () => {
  const items = computeReminders(
    [v({ id: 'a', next_maintenance_km: '10000' })],
    [{ vehicle_id: 'a', odometer_km: '9999.7', has_data: true }], S, TODAY)
  assertEquals(items.map(i => [i.remaining, i.overdue]), [[0, true]])
})

Deno.test('mantenimiento por km: redondea hacia abajo cuando falta menos de 1 km entero', () => {
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
    v({ id: 'z', name: 'Zeta', insurance_expiry: '2026-09-27' }),
    v({ id: 'a', name: 'Alfa', insurance_expiry: '2026-09-27' }),
  ], [], S, TODAY)
  assertEquals(items.map(i => i.vehicleId), ['a', 'z'])
})

Deno.test('orden: vencidos primero; dentro de cada grupo, seguro, fecha, km y lo más urgente antes', () => {
  const items = computeReminders([
    v({ id: 'x', next_maintenance_km: 10500, insurance_expiry: '2026-10-10', next_maintenance_date: '2026-09-01' }),
    v({ id: 'y', insurance_expiry: '2026-09-25' }),
  ], [odo('x', 10000)], S, TODAY)
  assertEquals(items.map(i => [i.vehicleId, i.kind, i.overdue]), [
    ['y', 'insurance', true],
    ['x', 'maintenance_date', true],
    ['x', 'insurance', false],
    ['x', 'maintenance_km', false],
  ])
  assertEquals(items[3].dueKm, 10500)
  assertEquals(items[2].dueDate, '2026-10-10')
})
