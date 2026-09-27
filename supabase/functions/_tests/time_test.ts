import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { dayRangeUtc, resolveDate, startOfDayUtc, isValidDate, hourInTz, daysBetween, isoWeekday } from '../_shared/time.ts'

Deno.test('día en UTC-4 fijo coincide con el rango que usaba la versión anterior', () => {
  // Antes: begin = "<fecha> 04:00:00", end = "<fecha+1> 03:59:59" (UTC)
  const { from, to } = dayRangeUtc('2026-09-25', 'America/La_Paz')
  assertEquals(from.toISOString(), '2026-09-25T04:00:00.000Z')
  assertEquals(to.toISOString(), '2026-09-26T03:59:59.000Z')
})

Deno.test('UTC', () => {
  const { from, to } = dayRangeUtc('2026-01-01', 'UTC')
  assertEquals(from.toISOString(), '2026-01-01T00:00:00.000Z')
  assertEquals(to.toISOString(), '2026-01-01T23:59:59.000Z')
})

Deno.test('zona con horario de verano: día de 23 h (inicio del DST)', () => {
  // Madrid 2026-03-29: a las 02:00 pasa a 03:00 (UTC+1 → UTC+2)
  const { from, to } = dayRangeUtc('2026-03-29', 'Europe/Madrid')
  assertEquals(from.toISOString(), '2026-03-28T23:00:00.000Z')
  assertEquals(to.toISOString(), '2026-03-29T21:59:59.000Z')
})

Deno.test('zona con horario de verano: día de 25 h (fin del DST)', () => {
  // Nueva York 2026-11-01: a las 02:00 vuelve a 01:00 (UTC-4 → UTC-5)
  const { from, to } = dayRangeUtc('2026-11-01', 'America/New_York')
  assertEquals(from.toISOString(), '2026-11-01T04:00:00.000Z')
  assertEquals(to.toISOString(), '2026-11-02T04:59:59.000Z')
})

Deno.test('zona adelantada a UTC', () => {
  assertEquals(startOfDayUtc('2026-09-26', 'Asia/Tokyo').toISOString(), '2026-09-25T15:00:00.000Z')
})

Deno.test('resolveDate: hoy/ayer según la zona, no según UTC', () => {
  // 2026-09-26 02:00 UTC = 2026-09-25 22:00 en UTC-4
  const now = new Date('2026-09-26T02:00:00Z')
  assertEquals(resolveDate('today', 'America/La_Paz', now), '2026-09-25')
  assertEquals(resolveDate(undefined, 'America/La_Paz', now), '2026-09-24')
  assertEquals(resolveDate('yesterday', 'UTC', now), '2026-09-25')
  assertEquals(resolveDate('2026-02-28', 'UTC', now), '2026-02-28')
})

Deno.test('resolveDate rechaza fechas inválidas', () => {
  assertThrows(() => resolveDate('2026-02-30', 'UTC'))
  assertThrows(() => resolveDate('ayer', 'UTC'))
  assertEquals(isValidDate('2026-13-01'), false)
})

Deno.test('hourInTz: hora local 0-23', () => {
  // 11:30 UTC = 07:30 en UTC-4
  assertEquals(hourInTz(new Date('2026-09-26T11:30:00Z'), 'America/La_Paz'), 7)
  assertEquals(hourInTz(new Date('2026-09-26T03:59:00Z'), 'America/La_Paz'), 23)
  assertEquals(hourInTz(new Date('2026-09-26T04:00:00Z'), 'America/La_Paz'), 0)
})

Deno.test('daysBetween: días de calendario', () => {
  assertEquals(daysBetween('2026-09-26', '2026-10-01'), 5)
  assertEquals(daysBetween('2026-09-26', '2026-09-26'), 0)
  assertEquals(daysBetween('2026-09-26', '2026-09-20'), -6)
  assertEquals(daysBetween('2026-02-28', '2026-03-01'), 1)
})

Deno.test('isoWeekday: 1 = lunes … 7 = domingo', () => {
  assertEquals(isoWeekday('2026-09-28'), 1) // lunes
  assertEquals(isoWeekday('2026-10-02'), 5) // viernes
  assertEquals(isoWeekday('2026-09-27'), 7) // domingo
})
