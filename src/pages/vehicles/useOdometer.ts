import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { Vehicle } from '@/types'

export interface Odometer {
  km: number
  // 'gps': odómetro base + km diarios del GPS.
  // 'manual': mayor valor entre el odómetro base y la última lectura de la bitácora.
  source: 'gps' | 'manual'
  hasData: boolean
  // true si el valor mostrado sale de una lectura de la bitácora (no del odómetro base).
  fromLog: boolean
}

// Lee el odómetro de la vista vehicle_odometer: la misma regla que usan los
// correos de recordatorio. `refreshKey` fuerza a releer.
export function useOdometer(vehicle: Vehicle, refreshKey: number): Odometer {
  const key = `${vehicle.id}:${refreshKey}`
  const [row, setRow] = useState<{ key: string; value: Odometer | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    supabase
      .from('vehicle_odometer')
      .select('odometer_km, source, from_log, has_data')
      .eq('vehicle_id', vehicle.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        setRow({
          key,
          value: data
            ? { km: Number(data.odometer_km), source: data.source, hasData: data.has_data, fromLog: data.from_log }
            : null,
        })
      })
    return () => { cancelled = true }
  }, [vehicle.id, key])

  if (row?.key === key && row.value) return row.value

  // Mientras carga: el odómetro base del vehículo.
  const base = Number(vehicle.odometer_offset) || 0
  return { km: base, source: vehicle.gps_device_id ? 'gps' : 'manual', hasData: base > 0, fromLog: false }
}
