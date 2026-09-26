// Caché compartida entre instancias de las edge functions, en la tabla
// gps_cache (solo accesible con la secret key). Útil para tokens de acceso y
// respuestas costosas, para no chocar con los límites de los proveedores.
import { adminClient } from '../supabase.ts'

export interface GpsCache {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
  delete(key: string): Promise<void>
}

export function gpsCache(provider: string): GpsCache {
  const db = adminClient()
  return {
    async get(key) {
      const { data } = await db
        .from('gps_cache')
        .select('value, expires_at')
        .eq('provider', provider)
        .eq('key', key)
        .maybeSingle()
      if (!data || new Date(data.expires_at) <= new Date()) return null
      return data.value
    },
    async set(key, value, ttlSeconds) {
      const expires_at = new Date(Date.now() + ttlSeconds * 1000).toISOString()
      const { error } = await db
        .from('gps_cache')
        .upsert({ provider, key, value, expires_at }, { onConflict: 'provider,key' })
      if (error) console.warn(`gps_cache: no se pudo guardar ${provider}/${key}:`, error.message)
    },
    async delete(key) {
      await db.from('gps_cache').delete().eq('provider', provider).eq('key', key)
    },
  }
}
