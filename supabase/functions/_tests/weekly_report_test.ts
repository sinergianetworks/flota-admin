import { assertEquals } from 'jsr:@std/assert@1'
import { buildWeeklyReport, type WeeklyVehicle } from '../_shared/weekly_report.ts'

const S = { maintenance_km_threshold: 2000, maintenance_days_threshold: 15, insurance_days_threshold: 30 }
const TODAY = '2026-09-28' // lunes

function veh(p: Partial<WeeklyVehicle> & { id: string }): WeeklyVehicle {
  return {
    name: p.id, plate: null, active: true, next_maintenance_km: null, next_maintenance_date: null,
    insurance_company: null, insurance_expiry: null, gps_device_id: null, driver: null, ...p,
  }
}

Deno.test('período: los 7 días anteriores a hoy', () => {
  const r = buildWeeklyReport({ vehicles: [], odometers: [], mileage: [] }, S, TODAY)
  assertEquals([r.periodFrom, r.periodTo], ['2026-09-21', '2026-09-27'])
  assertEquals(r.totals, { vehicles: 0, weekKm: 0, alerts: 0 })
})

Deno.test('filas: odómetro, km de la semana (solo con GPS), conductor y orden por nombre', () => {
  const r = buildWeeklyReport({
    vehicles: [
      veh({ id: 'b', name: 'Sedán', gps_device_id: null, driver: { full_name: 'Ana' } }),
      veh({ id: 'a', name: 'Pickup', plate: 'AB-1', gps_device_id: '111' }),
      veh({ id: 'z', name: 'Inactivo', active: false }),
    ],
    odometers: [
      { vehicle_id: 'a', odometer_km: '51176.47', has_data: true },
      { vehicle_id: 'b', odometer_km: 0, has_data: false },
    ],
    mileage: [
      { vehicle_id: 'a', date: '2026-09-20', km: 999 },   // fuera del período
      { vehicle_id: 'a', date: '2026-09-21', km: 100.5 },
      { vehicle_id: 'a', date: '2026-09-27', km: 50.25 },
      { vehicle_id: 'a', date: '2026-09-28', km: 999 },   // hoy, fuera
    ],
  }, S, TODAY)
  assertEquals(r.rows.map(x => [x.name, x.odometerKm, x.weekKm, x.driver]), [
    ['Pickup', 51176, 150.75, null],
    ['Sedán', null, null, 'Ana'],
  ])
  assertEquals(r.totals.vehicles, 2)
  assertEquals(r.totals.weekKm, 150.75)
})

Deno.test('mantenimiento: km por defecto; fecha si solo la fecha está en alerta', () => {
  const r = buildWeeklyReport({
    vehicles: [
      veh({ id: 'km', next_maintenance_km: 60000, next_maintenance_date: '2026-12-01' }),
      veh({ id: 'fecha', next_maintenance_km: 60000, next_maintenance_date: '2026-10-01' }),
      veh({ id: 'solo-fecha', next_maintenance_date: '2027-01-01' }),
      veh({ id: 'nada' }),
    ],
    odometers: ['km', 'fecha', 'solo-fecha', 'nada'].map(id => ({ vehicle_id: id, odometer_km: 50000, has_data: true })),
    mileage: [],
  }, S, TODAY)
  const m = Object.fromEntries(r.rows.map(x => [x.vehicleId, x.maintenance]))
  assertEquals(m.km, { kind: 'km', remainingKm: 10000 })
  assertEquals(m.fecha, { kind: 'date', remainingDays: 3, date: '2026-10-01' })
  assertEquals(m['solo-fecha'], { kind: 'date', remainingDays: 95, date: '2027-01-01' })
  assertEquals(m.nada, null)
})

Deno.test('alertas: mantenimiento y seguro, ordenadas, con total', () => {
  const r = buildWeeklyReport({
    vehicles: [
      veh({ id: 'a', name: 'A', next_maintenance_km: 50500, insurance_expiry: '2026-09-28', insurance_company: 'Aseg' }),
      veh({ id: 'b', name: 'B', insurance_expiry: '2027-01-01' }),
    ],
    odometers: [{ vehicle_id: 'a', odometer_km: 50000, has_data: true }],
    mileage: [],
  }, S, TODAY)
  assertEquals(r.attention.map(i => [i.vehicleId, i.kind, i.overdue]), [['a', 'insurance', true], ['a', 'maintenance_km', false]])
  assertEquals(r.totals.alerts, 2)
  const a = r.rows.find(x => x.vehicleId === 'a')!
  assertEquals(a.insurance, { expiry: '2026-09-28', remainingDays: 0, company: 'Aseg' })
  assertEquals(a.alerts.length, 2)
})

Deno.test('mantenimiento: km y fecha en alerta (ninguno vencido) → km', () => {
  const r = buildWeeklyReport({
    vehicles: [veh({ id: 'a', next_maintenance_km: 51000, next_maintenance_date: '2026-10-05' })], // +1000km, +7 días
    odometers: [{ vehicle_id: 'a', odometer_km: 50000, has_data: true }],
    mileage: [],
  }, S, TODAY)
  assertEquals(r.rows[0].maintenance, { kind: 'km', remainingKm: 1000 })
})

Deno.test('mantenimiento: fecha vencida con km solo próximo (no vencido) → fecha', () => {
  const r = buildWeeklyReport({
    vehicles: [veh({ id: 'a', next_maintenance_km: 51000, next_maintenance_date: '2026-09-23' })], // +1000km, -5 días
    odometers: [{ vehicle_id: 'a', odometer_km: 50000, has_data: true }],
    mileage: [],
  }, S, TODAY)
  assertEquals(r.rows[0].maintenance, { kind: 'date', remainingDays: -5, date: '2026-09-23' })
})

Deno.test('mantenimiento: km sin odómetro y sin fecha → km_unknown', () => {
  const r = buildWeeklyReport({
    vehicles: [veh({ id: 'a', next_maintenance_km: 60000 })],
    odometers: [{ vehicle_id: 'a', odometer_km: 0, has_data: false }],
    mileage: [],
  }, S, TODAY)
  assertEquals(r.rows[0].maintenance, { kind: 'km_unknown', dueKm: 60000 })
})

Deno.test('mantenimiento: km sin odómetro con fecha → fecha', () => {
  const r = buildWeeklyReport({
    vehicles: [veh({ id: 'a', next_maintenance_km: 60000, next_maintenance_date: '2027-01-01' })],
    odometers: [{ vehicle_id: 'a', odometer_km: 0, has_data: false }],
    mileage: [],
  }, S, TODAY)
  assertEquals(r.rows[0].maintenance, { kind: 'date', remainingDays: 95, date: '2027-01-01' })
})

Deno.test('estimatedDays: solo con GPS y al menos 7 días de kilometraje', () => {
  const week = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']
  const mileage = week.flatMap(date => [
    { vehicle_id: 'gps', date, km: 50 },
    { vehicle_id: 'nogps', date, km: 50 },
  ])
  const r = buildWeeklyReport({
    vehicles: [
      veh({ id: 'gps', name: 'Gps', next_maintenance_km: 50500, gps_device_id: '1' }),
      veh({ id: 'nogps', name: 'NoGps', next_maintenance_km: 50500, gps_device_id: null }),
    ],
    odometers: [
      { vehicle_id: 'gps', odometer_km: 50000, has_data: true },
      { vehicle_id: 'nogps', odometer_km: 50000, has_data: true },
    ],
    mileage,
  }, S, TODAY)
  const gpsAlert = r.attention.find(a => a.vehicleId === 'gps')
  const noGpsAlert = r.attention.find(a => a.vehicleId === 'nogps')
  assertEquals(gpsAlert?.estimatedDays, 40)
  assertEquals(noGpsAlert?.estimatedDays, undefined)
})

Deno.test('km no finito en el kilometraje se ignora', () => {
  const r = buildWeeklyReport({
    vehicles: [veh({ id: 'a', gps_device_id: '1' })],
    odometers: [],
    mileage: [
      { vehicle_id: 'a', date: '2026-09-27', km: 100 },
      { vehicle_id: 'a', date: '2026-09-26', km: NaN },
      { vehicle_id: 'a', date: '2026-09-25', km: 'no-es-numero' as unknown as number },
    ],
  }, S, TODAY)
  assertEquals(r.rows[0].weekKm, 100)
})
