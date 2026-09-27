import { useEffect, useState } from 'react'
import { Archive, Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import type { Vehicle } from '@/types'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface Props {
  vehicle: Vehicle
  open: boolean
  onClose: () => void
  onArchived: () => void
}

// Confirma el archivado de un vehículo: deja de aparecer en la flota, el GPS y
// los correos, pero conserva su historial. Opcionalmente libera el equipo GPS
// para poder asignarlo a otro vehículo (un equipo no puede estar en dos).
export default function ArchiveVehicleDialog({ vehicle, open, onClose, onArchived }: Props) {
  const [releaseGps, setReleaseGps] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const hasGps = !!vehicle.gps_device_id

  useEffect(() => {
    if (!open) return
    // Se reinicia al abrir; se difiere para no actualizar estado dentro del efecto.
    const t = setTimeout(() => { setReleaseGps(false); setError('') }, 0)
    return () => clearTimeout(t)
  }, [open])

  async function handleArchive() {
    setSaving(true)
    setError('')
    const patch: Partial<Vehicle> = { active: false }
    if (releaseGps) {
      patch.gps_provider = null
      patch.gps_device_id = null
    }
    const { data, error: err } = await supabase.from('vehicles').update(patch).eq('id', vehicle.id).select('id')
    setSaving(false)
    if (err) {
      setError(err.message)
      return
    }
    if (!data || data.length === 0) {
      setError('No se archivó: no tienes permiso o el vehículo no existe.')
      return
    }
    onArchived()
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Archive size={18} />
            Archivar {vehicle.name}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2 text-sm">
          <p className="text-muted-foreground">
            El vehículo dejará de aparecer en la flota, en el GPS y en los correos. Su historial se conserva y
            puedes restaurarlo cuando quieras desde el filtro <strong>Archivados</strong>.
          </p>

          {hasGps && (
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-[hsl(var(--primary))]"
                checked={releaseGps}
                onChange={e => setReleaseGps(e.target.checked)}
              />
              <span>
                Liberar el equipo GPS ({vehicle.gps_provider} · {vehicle.gps_device_id}) para usarlo en otro vehículo
                <span className="block text-xs text-muted-foreground">
                  Si no lo liberas, el equipo queda asociado a este vehículo aunque esté archivado.
                </span>
              </span>
            </label>
          )}

          {error && <p role="status" aria-live="polite" className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg break-all">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button variant="destructive" onClick={handleArchive} disabled={saving}>
            {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Archivando...</> : 'Archivar'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
