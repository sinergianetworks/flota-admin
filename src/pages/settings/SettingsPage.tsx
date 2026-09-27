import { useEffect, useState } from 'react'
import { Settings, Loader2, Mail, CalendarDays, Shield, Users } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { invokeFunction } from '@/lib/functions'
import { DEFAULT_SETTINGS, fetchFleetSettingsStrict, setFleetSettingsCache, type FleetSettings } from '@/lib/settings'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type NumberKey = 'maintenance_km_threshold' | 'maintenance_days_threshold' | 'insurance_days_threshold'

interface Form {
  numbers: Record<NumberKey, string>
  emails: string // un correo por línea (también se aceptan comas)
  dailyEnabled: boolean
  weeklyEnabled: boolean
  weeklyDay: number
}

const MAX: Record<NumberKey, number> = {
  maintenance_km_threshold: 1_000_000,
  maintenance_days_threshold: 3_650,
  insurance_days_threshold: 3_650,
}
const MAX_EMAILS = 50
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const WEEKDAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']

function toForm(s: FleetSettings): Form {
  return {
    numbers: {
      maintenance_km_threshold: String(s.maintenance_km_threshold),
      maintenance_days_threshold: String(s.maintenance_days_threshold),
      insurance_days_threshold: String(s.insurance_days_threshold),
    },
    emails: s.notification_emails.join('\n'),
    dailyEnabled: s.email_reminders_enabled,
    weeklyEnabled: s.weekly_report_enabled,
    weeklyDay: s.weekly_report_day,
  }
}

function parseEmails(raw: string): string[] {
  return [...new Set(raw.split(/[\n,;]+/).map(e => e.trim().toLowerCase()).filter(Boolean))]
}

// Forma normalizada para comparar si hay cambios sin guardar.
function normalize(f: Form) {
  return JSON.stringify({ ...f, emails: parseEmails(f.emails) })
}

type Result = { ok: boolean; text: string } | null

export default function SettingsPage() {
  const [loaded, setLoaded] = useState<FleetSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [form, setForm] = useState<Form>(toForm(DEFAULT_SETTINGS))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<Result>(null)
  const [testing, setTesting] = useState<'daily' | 'weekly' | null>(null)
  const [testResult, setTestResult] = useState<{ kind: 'daily' | 'weekly'; result: Result } | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchFleetSettingsStrict()
      .then(s => {
        if (cancelled) return
        setLoaded(s)
        setForm(toForm(s))
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

  function update(patch: Partial<Form>) {
    setMessage(null)
    setForm(f => ({ ...f, ...patch }))
  }

  const dirty = loaded != null && normalize(form) !== normalize(toForm(loaded))

  async function handleSave() {
    if (!loaded) return
    setMessage(null)
    const entries = Object.entries(form.numbers) as [NumberKey, string][]
    const invalid = entries.find(([key, v]) => {
      const n = Number(v)
      return !Number.isInteger(n) || n < 1 || n > MAX[key]
    })
    if (invalid) {
      setMessage({ ok: false, text: `Los umbrales deben ser números enteros entre 1 y ${MAX[invalid[0]]}.` })
      return
    }
    const emails = parseEmails(form.emails)
    const badEmail = emails.find(e => !EMAIL_RE.test(e))
    if (badEmail) {
      setMessage({ ok: false, text: `"${badEmail}" no es un correo válido.` })
      return
    }
    if (emails.length > MAX_EMAILS) {
      setMessage({ ok: false, text: `Máximo ${MAX_EMAILS} destinatarios.` })
      return
    }
    const values = {
      ...Object.fromEntries(entries.map(([k, v]) => [k, Number(v)])) as Record<NumberKey, number>,
      notification_emails: emails,
      email_reminders_enabled: form.dailyEnabled,
      weekly_report_enabled: form.weeklyEnabled,
      weekly_report_day: form.weeklyDay,
    }
    setSaving(true)
    const { data, error } = await supabase.from('fleet_settings').update(values).eq('id', true).select('id')
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
      // La escritura funcionó; si la relectura falla, usamos los valores guardados.
      refreshed = values
      setFleetSettingsCache(refreshed)
    }
    setLoaded(refreshed)
    setForm(toForm(refreshed))
    setMessage({ ok: true, text: 'Configuración guardada.' })
  }

  async function handleTest(kind: 'daily' | 'weekly') {
    setTesting(kind)
    setTestResult(null)
    try {
      const fn = kind === 'daily' ? 'send-reminders' : 'send-weekly-report'
      const res = await invokeFunction<{ items: number }>(fn, { test: true })
      const text = kind === 'daily'
        ? (res.items > 0
          ? `Correo enviado a tu dirección con ${res.items} alerta${res.items === 1 ? '' : 's'} de mantenimiento.`
          : 'Correo enviado a tu dirección (hoy no hay mantenimientos por vencer).')
        : `Reporte enviado a tu dirección con ${res.items} vehículo${res.items === 1 ? '' : 's'}.`
      setTestResult({ kind, result: { ok: true, text } })
    } catch (e) {
      setTestResult({ kind, result: { ok: false, text: e instanceof Error ? e.message : String(e) } })
    } finally {
      setTesting(null)
    }
  }

  const numberField = (key: NumberKey, label: string, suffix: string, help: string) => {
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
            value={form.numbers[key]}
            aria-describedby={helpId}
            onChange={e => update({ numbers: { ...form.numbers, [key]: e.target.value } })}
          />
          <span className="text-sm text-muted-foreground">{suffix}</span>
        </div>
        <p id={helpId} className="text-xs text-muted-foreground">{help}</p>
      </div>
    )
  }

  const testButton = (kind: 'daily' | 'weekly', label: string) => (
    <div className="space-y-1">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="outline" size="sm" onClick={() => handleTest(kind)} disabled={testing != null || dirty}>
          {testing === kind ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Enviando...</> : label}
        </Button>
        {dirty && <p className="text-sm text-muted-foreground">Guarda los cambios para probar con la nueva configuración.</p>}
        {testResult?.kind === kind && testResult.result && (
          <p role="status" aria-live="polite" className={`text-sm ${testResult.result.ok ? 'text-green-700' : 'text-red-600'}`}>
            {testResult.result.text}
          </p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">La prueba se envía solo a tu correo y usa la configuración guardada.</p>
    </div>
  )

  const checkbox = (checked: boolean, onChange: (v: boolean) => void, label: string, help: string) => (
    <label className="flex items-start gap-3 cursor-pointer">
      <input type="checkbox" className="mt-1 h-4 w-4 accent-[hsl(var(--primary))]" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="text-sm">
        {label}
        <span className="block text-xs text-muted-foreground">{help}</span>
      </span>
    </label>
  )

  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Settings size={22} />
          Configuración
        </h1>
        <p className="text-sm text-muted-foreground">Correos de la flota: destinatarios, alertas diarias y reporte semanal</p>
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
            <CardContent className="pt-6 space-y-3">
              <h2 className="font-medium flex items-center gap-2"><Users size={16} /> Destinatarios de los correos</h2>
              <Label htmlFor="notification_emails" className="sr-only">Destinatarios</Label>
              <textarea
                id="notification_emails"
                rows={4}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder={'flota@tu-empresa.com\njefe.taller@tu-empresa.com'}
                value={form.emails}
                aria-describedby="notification_emails-help"
                onChange={e => update({ emails: e.target.value })}
              />
              <p id="notification_emails-help" className="text-xs text-muted-foreground">
                Un correo por línea (hasta {MAX_EMAILS}). Reciben las alertas diarias y el reporte semanal. Si lo dejas vacío, se envían a los administradores activos.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6 space-y-5">
              <h2 className="font-medium flex items-center gap-2"><Mail size={16} /> Alertas diarias de mantenimiento</h2>
              {checkbox(form.dailyEnabled, v => update({ dailyEnabled: v }), 'Enviar alertas diarias',
                'Se envían a partir de las 7:00 (hora local) solo si hay mantenimientos por vencer o vencidos, y se repiten cada día hasta que se actualice el dato.')}
              {numberField('maintenance_km_threshold', 'Avisar por kilometraje', 'km antes',
                'La tarjeta pasa a "Próximo pronto" y se incluye en la alerta.')}
              {numberField('maintenance_days_threshold', 'Avisar por fecha', 'días antes',
                'Para vehículos con fecha de próximo mantenimiento.')}
              {testButton('daily', 'Probar alerta diaria')}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6 space-y-5">
              <h2 className="font-medium flex items-center gap-2"><CalendarDays size={16} /> Reporte semanal</h2>
              {checkbox(form.weeklyEnabled, v => update({ weeklyEnabled: v }), 'Enviar el reporte semanal',
                'Resumen de todos los vehículos de los últimos 7 días. Se envía a partir de las 7:00 (hora local) del día elegido.')}
              <div className="space-y-1">
                <Label htmlFor="weekly_report_day">Día de envío</Label>
                <select
                  id="weekly_report_day"
                  className="block w-48 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={form.weeklyDay}
                  onChange={e => update({ weeklyDay: Number(e.target.value) })}
                >
                  {WEEKDAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
                </select>
              </div>
              {testButton('weekly', 'Probar reporte semanal')}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6 space-y-5">
              <h2 className="font-medium flex items-center gap-2"><Shield size={16} /> Seguro</h2>
              {numberField('insurance_days_threshold', 'Avisar vencimiento del seguro', 'días antes',
                'Alerta en la tarjeta y en el reporte semanal.')}
            </CardContent>
          </Card>

          <div className="flex items-center justify-end gap-3">
            {message && (
              <p role="status" aria-live="polite" className={`text-sm ${message.ok ? 'text-green-700' : 'text-red-600'}`}>
                {message.text}
              </p>
            )}
            <Button onClick={handleSave} disabled={saving || !dirty}>
              {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Guardando...</> : 'Guardar'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
