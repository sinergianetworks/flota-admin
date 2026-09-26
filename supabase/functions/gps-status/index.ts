// gps-status: único punto por el que el frontend consulta a los proveedores GPS.
//
//   { action: 'providers' }              → proveedores registrados (cualquier usuario)
//   { action: 'devices', provider }      → equipos de la cuenta (solo admin)
//   { action: 'live' }                   → estado en vivo de los vehículos que el
//                                          usuario puede ver según la RLS
//   { action: 'validate', provider }     → prueba las credenciales (solo admin)
import { serve, json, readJson, HttpError } from '../_shared/http.ts'
import { adminClient, requireUser, userClient } from '../_shared/supabase.ts'
import { getProvider, listProviders } from '../_shared/gps/providers/index.ts'

interface Body {
  action?: string
  provider?: string
}

function configuredProvider(id: string | undefined) {
  const provider = id ? getProvider(id) : undefined
  if (!provider) throw new HttpError(400, `Proveedor GPS desconocido: ${id ?? '(vacío)'}`)
  if (!provider.isConfigured()) throw new HttpError(400, `El proveedor ${provider.name} no está configurado (faltan secrets).`)
  return provider
}

serve(async (req) => {
  const admin = adminClient()
  const caller = await requireUser(req, admin)
  const body = await readJson<Body>(req)

  switch (body.action) {
    case 'providers':
      return json({
        providers: listProviders().map(p => ({ id: p.id, name: p.name, configured: p.isConfigured() })),
      })

    case 'devices': {
      if (caller.role !== 'admin') throw new HttpError(403, 'Solo un administrador puede hacer esto')
      const provider = configuredProvider(body.provider)
      if (!provider.listDevices) throw new HttpError(400, `${provider.name} no permite listar equipos; escribe el ID a mano.`)
      return json({ devices: await provider.listDevices() })
    }

    case 'validate': {
      if (caller.role !== 'admin') throw new HttpError(403, 'Solo un administrador puede hacer esto')
      const provider = configuredProvider(body.provider)
      try {
        await provider.validateCredentials()
        return json({ ok: true })
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }

    case 'live': {
      // Se consulta con el cliente del usuario: la RLS limita los vehículos.
      const { data: vehicles, error } = await userClient(caller.token)
        .from('vehicles')
        .select('id, gps_provider, gps_device_id')
        .eq('active', true)
        .not('gps_device_id', 'is', null)
      if (error) throw new HttpError(500, error.message)

      const byProvider = new Map<string, { id: string; deviceId: string }[]>()
      for (const v of vehicles ?? []) {
        const list = byProvider.get(v.gps_provider) ?? []
        list.push({ id: v.id, deviceId: v.gps_device_id })
        byProvider.set(v.gps_provider, list)
      }

      const statuses = []
      const errors: string[] = []
      for (const [providerId, items] of byProvider) {
        const provider = getProvider(providerId)
        if (!provider?.getLiveStatus || !provider.isConfigured()) continue
        try {
          const list = await provider.getLiveStatus(items.map(i => i.deviceId))
          const byDevice = new Map(list.map(s => [s.deviceId, s]))
          for (const item of items) {
            const s = byDevice.get(item.deviceId)
            if (s) statuses.push({ vehicleId: item.id, ...s })
          }
        } catch (e) {
          // Un proveedor caído no debe impedir mostrar los demás.
          console.error(`gps-status: ${providerId}`, e)
          errors.push(`${provider.name}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      return json({ statuses, errors })
    }

    default:
      throw new HttpError(400, 'Acción inválida (providers | devices | live | validate).')
  }
})
