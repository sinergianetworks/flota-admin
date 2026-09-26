import { invokeFunction } from './functions'
import type { GpsDevice, GpsProviderInfo, LiveStatus } from '@/types'

// El frontend nunca habla con el proveedor GPS: todo pasa por la edge function
// gps-status, que valida la sesión y aplica la RLS del usuario.

export async function listGpsProviders(): Promise<GpsProviderInfo[]> {
  const res = await invokeFunction<{ providers: GpsProviderInfo[] }>('gps-status', { action: 'providers' })
  return res.providers
}

// Solo admin.
export async function listGpsDevices(provider: string): Promise<GpsDevice[]> {
  const res = await invokeFunction<{ devices: GpsDevice[] }>('gps-status', { action: 'devices', provider })
  return res.devices
}

// Estado en vivo de los vehículos con GPS que el usuario puede ver.
export async function getLiveStatuses(): Promise<Record<string, LiveStatus>> {
  const res = await invokeFunction<{ statuses: LiveStatus[] }>('gps-status', { action: 'live' })
  return Object.fromEntries(res.statuses.map(s => [s.vehicleId, s]))
}

// Solo admin. Recalcula los km del día indicado (YYYY-MM-DD en APP_TIMEZONE).
export async function syncMileage(date: string): Promise<void> {
  await invokeFunction('sync-mileage', { date })
}
