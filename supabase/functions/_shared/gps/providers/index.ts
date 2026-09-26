// Registro de proveedores GPS.
//
// Para agregar uno nuevo: crea ./mi-proveedor.ts exportando un GpsProvider,
// impórtalo aquí y agrégalo a PROVIDERS. Su `id` es lo que se guarda en
// vehicles.gps_provider. Guía completa: docs/PROVEEDORES_GPS.md.
import type { GpsProvider } from '../types.ts'
import { tracksolid } from './tracksolid.ts'

const PROVIDERS: GpsProvider[] = [
  tracksolid,
]

export function listProviders(): GpsProvider[] {
  return PROVIDERS
}

export function getProvider(id: string): GpsProvider | undefined {
  return PROVIDERS.find(p => p.id === id)
}
