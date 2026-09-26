import { useEffect, useState } from 'react'
import { Settings, Loader2, Mail } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { invokeFunction } from '@/lib/functions'
import { DEFAULT_SETTINGS, fetchFleetSettingsStrict, type FleetSettings } from '@/lib/settings'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Fields = Record<'maintenance_km_threshold' | 'maintenance_days_threshold' | 'insurance_days_threshold', string>

// Máximos razonables para los umbrales (también validados en el input con `max`).
const MAX: Record<keyof Fields, number> = {
  maintenance_km_threshold: 1_000_000,
  maintenance_days_threshold: 3_650,
  insurance_days_threshold: 3_650,
}

function toFields(s: FleetSettings): Fields {
  return {
    maintenance_km_threshold: String(s.maintenance_km_threshold),
    maintenance_days_threshold: String(s.maintenance_days_threshold),
    insurance_days_threshold: String(s.insurance_days_threshold),
  }
}

export default function SettingsPage() {
  const [loaded, setLoaded] = useState<FleetSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [fields, setFields] = useState<Fields>(toFields(DEFAULT_SETTINGS))
  const [enabled, setEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    fetchFleetSettingsStrict()
      .then(s => {
        if (cancelled) return
        setLoaded(s)
        setFields(toFields(s))
        setEnabled(s.email_reminders_enabled)
      })
      .catch(e => {
        if (cancelled) return
        setLoadError(e instanceof Error ? e.message : String(e))
      })
    return () => { cancelled = true }
  }, [reloadKey])

  function handleRetry() {
    setLoaded(null)
    setLoadError(null)
    setReloadKey(k => k + 1)
  }

  const dirty = loaded != null && (
    JSON.stringify(fields) !== JSON.stringify(toFields(loaded)) || enabled !== loaded.email_reminders_enabled
  )

  async function handleSave() {
    if (!loaded) return
    setMessage(null)
    const entries = Object.entries(fields) as [keyof Fields, string][]
    const invalid = entries.find(([key, v]) => {
      const n = Number(v)
      return !Number.isInteger(n) || n < 1 || n > MAX[key]
    })
    if (invalid) {
      setMessage({ ok: false, text: `Los umbrales deben ser números enteros entre 1 y ${MAX[invalid[0]]}.` })
      return
    }
    const values = Object.fromEntries(entries.map(([k, v]) => [k, Number(v)])) as Record<keyof Fields, number>
    setSaving(true)
    const { data, error } = await supabase
      .from('fleet_settings')
      .update({ ...values, email_reminders_enabled: enabled, updated_at: new Date().toISOString() })
      .eq('id', true)
      .select('id')
    setSaving(false)
    if (error) {
      setMessage({ ok: false, text: error.message })
      return
    }
    if (!data || data.length === 0) {
      setMessage({ ok: false, text: 'No se guardó: no tienes permiso o la configuración no existe.' })
      return
    }
    let refreshed: FleetSettings
    try {
      refreshed = await fetchFleetSettingsStrict()
    } catch {
      // La escritura sí funcionó (hubo fila afectada); si la relectura falla,
      // usamos igual los valores recién guardados en vez de mostrar error.
      refreshed = { ...values, email_reminders_enabled: enabled }
    }
    setLoaded(refreshed)
    setFields(toFields(refreshed))
    setEnabled(refreshed.email_reminders_enabled)
    setMessage({ ok: true, text: 'Configuración guardada.' })
  }

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await invokeFunction<{ items: number }>('send-reminders', { test: true })
      setTestResult({
        ok: true,
        text: res.items > 0
          ? `Correo enviado a tu dirección con ${res.items} vencimiento${res.items === 1 ? '' : 's'}.`
          : 'Correo enviado a tu dirección (hoy no hay vencimientos).',
      })
    } catch (e) {
      setTestResult({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  const field = (key: keyof Fields, label: string, suffix: string, help: string) => {
    const helpId = `${key}-help`
    return (
      <div className="space-y-1">
        <Label htmlFor={key}>{label}</Label>
        <div className="flex items-center gap-2">
          <Input
            id={key}
            type="number"
            min={1}
            max={MAX[key]}
            step={1}
            className="w-32"
            value={fields[key]}
            aria-describedby={helpId}
            onChange={e => {
              setMessage(null)
              setFields(f => ({ ...f, [key]: e.target.value }))
            }}
          />
          <span className="text-sm text-muted-foreground">{suffix}</span>
        </div>
        <p id={helpId} className="text-xs text-muted-foreground">{help}</p>
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Settings size={22} />
          Configuración
        </h1>
        <p className="text-sm text-muted-foreground">Umbrales de aviso y recordatorios por correo</p>
      </div>

      {loadError ? (
        <div className="text-center py-12 space-y-3">
          <p className="text-sm text-red-600" role="status" aria-live="polite">
            No se pudo cargar la configuración. {loadError}
          </p>
          <Button variant="outline" size="sm" onClick={handleRetry}>Reintentar</Button>
        </div>
      ) : !loaded ? (
        <p className="text-sm text-muted-foreground text-center py-12">Cargando...</p>
      ) : (
        <>
          <Card>
            <CardContent className="pt-6 space-y-5">
              <h2 className="font-medium">Avisar con anticipación</h2>
              {field('maintenance_km_threshold', 'Mantenimiento por kilometraje', 'km antes',
                'La tarjeta pasa a "Próximo pronto" y se incluye en el correo.')}
              {field('maintenance_days_threshold', 'Mantenimiento por fecha', 'días antes',
                'Para vehículos con fecha de próximo mantenimiento.')}
              {field('insurance_days_threshold', 'Vencimiento del seguro', 'días antes',
                'Alerta en la tarjeta y aviso por correo.')}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6 space-y-4">
              <h2 className="font-medium flex items-center gap-2"><Mail size={16} /> Recordatorios por correo</h2>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-[hsl(var(--primary))]"
                  checked={enabled}
                  onChange={e => {
                    setMessage(null)
                    setEnabled(e.target.checked)
                  }}
                />
                <span className="text-sm">
                  Enviar un resumen diario de vencimientos
                  <span className="block text-xs text-muted-foreground">
                    Se envían a las 7:00 (hora local de la instalación) a todos los administradores activos, y se
                    repiten cada día hasta que se actualice el dato. Si hoy ya se envió o no había vencimientos, los
                    cambios se aplican desde mañana.
                  </span>
                </span>
              </label>
              <div className="flex items-center gap-3 flex-wrap">
                <Button variant="outline" size="sm" onClick={handleTest} disabled={testing || dirty}>
                  {testing ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Enviando...</> : 'Enviar correo de prueba'}
                </Button>
                {dirty && (
                  <p className="text-sm text-muted-foreground">
                    Guarda los cambios para probar con la nueva configuración.
                  </p>
                )}
                {testResult && (
                  <p role="status" aria-live="polite" className={`text-sm ${testResult.ok ? 'text-green-700' : 'text-red-600'}`}>
                    {testResult.text}
                  </p>
                )}
              </div>
              <p className="text-xs text-muted-foreground">La prueba usa la configuración guardada.</p>
            </CardContent>
          </Card>

          <div className="flex items-center justify-end gap-3">
            {message && (
              <p role="status" aria-live="polite" className={`text-sm ${message.ok ? 'text-green-700' : 'text-red-600'}`}>
                {message.text}
              </p>
            )}
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Guardando...</> : 'Guardar'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
