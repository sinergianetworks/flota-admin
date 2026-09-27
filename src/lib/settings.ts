import { useEffect, useState } from 'react'
import { supabase } from './supabase'

// Umbrales de aviso de la instalación (tabla fleet_settings, una sola fila).
// Los mismos valores usan send-reminders y send-weekly-report.
export interface FleetSettings {
  maintenance_km_threshold: number
  maintenance_days_threshold: number
  insurance_days_threshold: number
  email_reminders_enabled: boolean
  notification_emails: string[]
  weekly_report_enabled: boolean
  weekly_report_day: number // 1 = lunes … 7 = domingo
}

export const DEFAULT_SETTINGS: FleetSettings = {
  maintenance_km_threshold: 2000,
  maintenance_days_threshold: 15,
  insurance_days_threshold: 30,
  email_reminders_enabled: true,
  notification_emails: [],
  weekly_report_enabled: true,
  weekly_report_day: 1,
}

const COLUMNS = 'maintenance_km_threshold, maintenance_days_threshold, insurance_days_threshold, email_reminders_enabled, notification_emails, weekly_report_enabled, weekly_report_day'

let cached: Promise<FleetSettings> | null = null
// Último valor resuelto con éxito (por carga normal o estricta). Sirve de
// estado inicial para useFleetSettings sin esperar al primer efecto.
let resolved: FleetSettings | null = null

// Lee la configuración una vez por sesión de la página. `force` la vuelve a
// leer (después de guardar cambios). Ante un error devuelve los defaults sin
// cachearlos.
export function loadFleetSettings(force = false): Promise<FleetSettings> {
  if (!cached || force) {
    const p: Promise<FleetSettings> = Promise.resolve(supabase.from('fleet_settings').select(COLUMNS).single()).then(({ data, error }) => {
      if (error || !data) {
        // Si mientras tanto otra carga (force) ya reemplazó la caché, no la pisamos.
        if (cached === p) cached = null
        return DEFAULT_SETTINGS
      }
      const settings = { ...DEFAULT_SETTINGS, ...data } as FleetSettings
      resolved = settings
      return settings
    })
    cached = p
  }
  return cached
}

// Como loadFleetSettings, pero lanza si hay error o no existe la fila en vez
// de devolver los defaults. La usa la página de Configuración para no dejar
// guardar valores por defecto sobre una lectura fallida.
export async function fetchFleetSettingsStrict(): Promise<FleetSettings> {
  const { data, error } = await supabase.from('fleet_settings').select(COLUMNS).single()
  if (error) throw error
  if (!data) throw new Error('No se encontró la configuración.')
  const settings = { ...DEFAULT_SETTINGS, ...data } as FleetSettings
  resolved = settings
  cached = Promise.resolve(settings)
  return settings
}

// Fija la caché con un valor ya conocido (p. ej. tras guardar cuando la
// relectura falla), para que las tarjetas no se queden con los umbrales viejos.
export function setFleetSettingsCache(s: FleetSettings): void {
  resolved = s
  cached = Promise.resolve(s)
}

export function useFleetSettings(): FleetSettings {
  const [settings, setSettings] = useState<FleetSettings>(() => resolved ?? DEFAULT_SETTINGS)
  useEffect(() => {
    let cancelled = false
    loadFleetSettings().then(s => { if (!cancelled) setSettings(s) })
    return () => { cancelled = true }
  }, [])
  return settings
}
