# Archivar vehículos — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que el admin pueda archivar un vehículo (ocultarlo sin perder su historial) desde el modal de edición, con la opción de liberar el equipo GPS, verlo en el filtro "Archivados" y restaurarlo.

**Architecture:**
- Solo frontend: usa la columna `vehicles.active`, que ya existe. La RLS, las edge functions y la vista `vehicle_odometer` ya ignoran los vehículos inactivos.
- Un diálogo nuevo de confirmación (`ArchiveVehicleDialog`).
- El modal de edición suma el botón "Archivar" y traduce el error de equipo GPS duplicado.
- La página suma el filtro "Activos / Archivados".
- La tarjeta tiene un modo "archivado".

**Tech Stack:** React 19 + Vite + TypeScript + Tailwind + shadcn/ui (Dialog, Button) y Supabase JS.

**Spec:** `docs/superpowers/specs/2026-09-27-archivar-vehiculos-design.md`

**Convenciones:**
- Rama `feature/archivar-vehiculos`. Hacer commit al terminar cada tarea y no hacer push.
- Texto en español.
- Verificación: `npm run lint && npm run build`. No hay tests de frontend; la verificación funcional es la Task 4, en el navegador.
- Los mensajes de commit terminan con una línea en blanco y `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- No tocar el proyecto Supabase de Campo.

---

## Mapa de archivos

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `src/pages/vehicles/ArchiveVehicleDialog.tsx` | Crear | Confirmación de archivado, con la opción de liberar el GPS |
| `src/pages/vehicles/VehicleModal.tsx` | Modificar | Botón "Archivar" y mensaje para el GPS duplicado |
| `src/pages/vehicles/VehicleCard.tsx` | Modificar | Modo archivado: etiqueta, acciones y botón "Restaurar" |
| `src/pages/vehicles/VehiclesPage.tsx` | Modificar | Filtro Activos/Archivados, carga por estado y restaurar |
| `README.md` | Modificar | Mencionar el archivado |

---

### Task 1: Diálogo de archivado y botón en el modal

**Files:**
- Create: `src/pages/vehicles/ArchiveVehicleDialog.tsx`
- Modify: `src/pages/vehicles/VehicleModal.tsx`

- [ ] **Step 1: Crear `ArchiveVehicleDialog.tsx`**

```tsx
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
```

Si `Button` no tiene la variante `destructive`, revisar `src/components/ui/button.tsx`. El shadcn estándar la incluye. Si falta, usar `variant="default"` y reportarlo.

- [ ] **Step 2: Modificar `VehicleModal.tsx`**

1. **Imports:** sumar `Archive` al import de `lucide-react` y agregar `import ArchiveVehicleDialog from './ArchiveVehicleDialog'`.

2. **Estado:** junto a los demás `useState`, agregar:

   ```tsx
   const [archiveOpen, setArchiveOpen] = useState(false)
   ```

3. **Error de GPS duplicado:** después de `const NONE = 'none'`, agregar:

   ```tsx
   // Mensaje para errores de guardado conocidos (restricciones de la base).
   function saveErrorMessage(err: { code?: string; message: string }): string {
     if (err.code === '23505' && err.message.includes('vehicles_gps_device_uidx')) {
       return 'Ese equipo GPS ya está asignado a otro vehículo (puede estar archivado). Libéralo en ese vehículo o elige otro.'
     }
     return err.message
   }
   ```

   En `handleSave`, reemplazar las dos líneas que lanzan el error del `update` y del `insert` del vehículo:

   ```tsx
   if (err) throw new Error(err.message)
   ```

   (la del `update(payload)`) por:

   ```tsx
   if (err) throw new Error(saveErrorMessage(err))
   ```

   y

   ```tsx
   if (err || !data) throw new Error(err?.message ?? 'No se pudo crear el vehículo.')
   ```

   por:

   ```tsx
   if (err || !data) throw new Error(err ? saveErrorMessage(err) : 'No se pudo crear el vehículo.')
   ```

4. **Botón "Archivar" en el pie:** reemplazar el bloque

   ```tsx
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
   ```

   por:

   ```tsx
        <div className="flex items-center gap-2 pt-2">
          {vehicle?.active && (
            <Button variant="ghost" className="mr-auto gap-1 text-muted-foreground" onClick={() => setArchiveOpen(true)} disabled={saving}>
              <Archive size={15} />
              Archivar
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
   ```

   El resto del bloque (el botón Guardar y el cierre `</div>`) queda igual.

5. **El diálogo:** justo antes de `</Dialog>` (el cierre del `Dialog` principal), agregar:

   ```tsx
      {vehicle && (
        <ArchiveVehicleDialog
          vehicle={vehicle}
          open={archiveOpen}
          onClose={() => setArchiveOpen(false)}
          onArchived={() => {
            setArchiveOpen(false)
            onSaved()
            onClose()
          }}
        />
      )}
   ```

   Si el anidamiento de dos `Dialog` de Radix da problemas de foco, renderizar el `ArchiveVehicleDialog` como hermano, envolviendo el return en un fragmento `<>…</>`. Reportar el cambio.

- [ ] **Step 3: Verificar**

Run: `npm run lint && npm run build`
Expected: sin errores.

- [ ] **Step 4: Commit**

```bash
git add src/pages/vehicles/ArchiveVehicleDialog.tsx src/pages/vehicles/VehicleModal.tsx
git commit -m "feat(web): archivar vehículos desde el modal, con opción de liberar el GPS"
```

---

### Task 2: Tarjeta en modo archivado

**Files:**
- Modify: `src/pages/vehicles/VehicleCard.tsx`

- [ ] **Step 1: Props e imports**

- En el import de `lucide-react`, sumar `Archive` y `RotateCcw`.
- En `interface Props`, agregar:

  ```tsx
    // Vista de archivados: sin GPS en vivo ni recorrido; permite restaurar.
    archived?: boolean
    onRestore?: () => Promise<void>
  ```

- Agregar `archived = false, onRestore` a la desestructuración de `export default function VehicleCard({ … })`.
- Agregar el estado `const [restoring, setRestoring] = useState(false)`.

- [ ] **Step 2: Etiqueta**

Reemplazar:

```tsx
          <div className="absolute top-2.5 right-2.5">
            <MovementBadge vehicle={vehicle} status={status} />
          </div>
```

por:

```tsx
          <div className="absolute top-2.5 right-2.5">
            {archived ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-semibold border shadow-sm bg-white/90 text-gray-600 border-gray-300">
                <Archive size={12} />
                Archivado
              </span>
            ) : (
              <MovementBadge vehicle={vehicle} status={status} />
            )}
          </div>
```

- [ ] **Step 3: Tarjeta atenuada**

Reemplazar `<Card className="overflow-hidden transition-shadow duration-200 hover:shadow-md">` por:

```tsx
      <Card className={`overflow-hidden transition-shadow duration-200 hover:shadow-md ${archived ? 'opacity-75' : ''}`}>
```

- [ ] **Step 4: Acciones**

En la barra de acciones (el `div` con `flex items-center gap-2 px-3 py-2.5 border-t border-gray-100`):
- Envolver el botón **Mapa** y el bloque `{hasGps && ( …Recorrido… )}` en `{!archived && ( <> … </> )}`.
- Justo después de esa apertura del `div`, agregar el botón de restaurar:

```tsx
            {archived && onRestore && (
              <button
                className="flex flex-1 items-center justify-center gap-1.5 h-[42px] rounded-[11px] text-[13.5px] font-[620] border border-gray-200 text-gray-700 bg-white hover:bg-gray-50 hover:border-gray-300 transition-colors disabled:opacity-50"
                onClick={async () => {
                  setRestoring(true)
                  try { await onRestore() } finally { setRestoring(false) }
                }}
                disabled={restoring}
                title="Restaurar vehículo"
              >
                <RotateCcw size={14} />
                {restoring ? 'Restaurando...' : 'Restaurar'}
              </button>
            )}
```

Los botones Bitácora y Editar no cambian.

- [ ] **Step 5: Verificar y commit**

Run: `npm run lint && npm run build`
Expected: sin errores.

```bash
git add src/pages/vehicles/VehicleCard.tsx
git commit -m "feat(web): tarjeta de vehículo archivado con opción de restaurar"
```

---

### Task 3: Filtro Activos / Archivados en la página

**Files:**
- Modify: `src/pages/vehicles/VehiclesPage.tsx`

- [ ] **Step 1: Carga por estado**

Reemplazar la función `loadFleet` completa por:

```tsx
// La RLS decide qué se ve: el admin ve toda la flota y el conductor solo su
// vehículo activo. Los archivados no consultan el GPS en vivo.
async function loadFleet(archived = false): Promise<Fleet> {
  const { data } = await supabase
    .from('vehicles')
    .select('*, driver:profiles(full_name)')
    .eq('active', !archived)
    .order('name')
  const vehicles = (data ?? []) as Vehicle[]
  if (archived || !vehicles.some(v => v.gps_device_id)) return { vehicles, statuses: {} }
  const statuses = await getLiveStatuses().catch(() => null)
  return { vehicles, statuses }
}
```

- [ ] **Step 2: Estado de la vista**

- Junto a los demás `useState`, agregar:

  ```tsx
  // Solo el admin puede ver los archivados.
  const [showArchived, setShowArchived] = useState(false)
  ```

- En `reload`, cambiar `applyFleet(await loadFleet())` por `applyFleet(await loadFleet(showArchived))` y agregar `showArchived` a sus dependencias: `[applyFleet, showArchived]`.

- En el `useEffect` de la carga inicial y el polling:
  - cambiar las dos llamadas `loadFleet()` por `loadFleet(showArchived)`;
  - no crear el intervalo en la vista de archivados;
  - agregar `showArchived` a las dependencias;
  - volver a mostrar el esqueleto al cambiar de vista, con un `loading` derivado.

  El efecto queda así:

```tsx
  const [loadedView, setLoadedView] = useState<boolean | null>(null)
  const loading = loadedView !== showArchived

  useEffect(() => {
    let cancelled = false
    loadFleet(showArchived).then(fleet => {
      if (cancelled) return
      applyFleet(fleet)
      setLoadedView(showArchived)
    })
    // Actualiza posición y estado en vivo cada minuto (solo activos).
    const interval = showArchived ? null : setInterval(() => {
      loadFleet(false).then(fleet => { if (!cancelled) applyFleet(fleet) })
    }, POLL_MS)
    return () => {
      cancelled = true
      if (interval) clearInterval(interval)
    }
  }, [applyFleet, showArchived])
```

  Eliminar el `useState` de `loading` anterior (`const [loading, setLoading] = useState(true)`) y cualquier `setLoading(false)` que quede. Si hay otro uso de `setLoading`, reemplazarlo por la lógica derivada y reportarlo.

- Agregar la función de restaurar, junto a `openNew` y `openEdit`:

```tsx
  async function restore(v: Vehicle) {
    const { error } = await supabase.from('vehicles').update({ active: true }).eq('id', v.id)
    if (error) {
      window.alert(`No se pudo restaurar: ${error.message}`)
      return
    }
    await reload()
  }
```

- [ ] **Step 3: Encabezado**

1. Cambiar el contador del admin:

   ```tsx
               {vehicles.length} vehículo{vehicles.length !== 1 ? 's' : ''}
   ```

   por:

   ```tsx
               {vehicles.length} vehículo{vehicles.length !== 1 ? 's' : ''}{showArchived ? ` archivado${vehicles.length !== 1 ? 's' : ''}` : ''}
   ```

2. En el `div` de los botones (`<div className="flex gap-2">`), agregar como primer hijo el selector (solo admin):

```tsx
          {isAdmin && (
            <div className="inline-flex rounded-md border bg-background p-0.5" role="group" aria-label="Filtrar vehículos">
              {([false, true] as const).map(archivedView => (
                <button
                  key={String(archivedView)}
                  className={`px-3 h-8 text-sm rounded-[5px] transition-colors ${showArchived === archivedView ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  aria-pressed={showArchived === archivedView}
                  onClick={() => setShowArchived(archivedView)}
                >
                  {archivedView ? 'Archivados' : 'Activos'}
                </button>
              ))}
            </div>
          )}
```

3. Envolver el botón **Mapa** y el botón **Agregar** en `{!showArchived && ( <> … </> )}`. El de Agregar ya está dentro de `{isAdmin && …}`; mantenerlo. El botón ⟳ (Actualizar) queda visible en las dos vistas.

4. Cambiar `<div className="flex gap-2">` por `<div className="flex gap-2 flex-wrap justify-end">`, para que en el celular no desborde.

- [ ] **Step 4: Estado vacío de archivados**

En el bloque `vehicles.length === 0 ? (…)`, antes de `{isAdmin ? (` agregar la rama de archivados:

```tsx
          {showArchived ? (
            <p className="font-medium">No hay vehículos archivados</p>
          ) : isAdmin ? (
```

y ajustar los paréntesis para que la estructura quede: `showArchived ? … : isAdmin ? (…admin…) : (…conductor…)`.

- [ ] **Step 5: Pasar el modo a las tarjetas**

En `<VehicleCard … />` agregar:

```tsx
              archived={showArchived}
              onRestore={isAdmin && showArchived ? () => restore(v) : undefined}
```

- [ ] **Step 6: Verificar y commit**

Run: `npm run lint && npm run build`
Expected: sin errores. Hay que respetar la regla `react-hooks/set-state-in-effect`: `setLoadedView` y `applyFleet` se llaman dentro del `.then`, no de forma sincrónica en el efecto.

```bash
git add src/pages/vehicles/VehiclesPage.tsx
git commit -m "feat(web): filtro Activos/Archivados y restaurar vehículos"
```

---

### Task 4: Verificación en el proyecto de prueba y documentación

La hace el coordinador en la vista previa (`localhost:4173`, proyecto `oklpfxskdujpaqxnwvbf`). No hay migración ni deploy de funciones.

- [ ] **Step 1: Build de la vista previa**

`npm run build`, generar `dist/env-config.js` con `docker/40-env-config.sh` y abrir `/vehiculos` con la sesión de admin.

- [ ] **Step 2: Flujo**

1. Editar "Sedán administrativo" (sin GPS) → **Archivar** → confirmar. Sale de "Activos", aparece en "Archivados" atenuado y con la etiqueta, sin Mapa ni Recorrido, y con Bitácora, Editar y Restaurar.
2. Editar "Furgón de reparto" (con GPS) → **Archivar**, marcando "Liberar el equipo GPS". En la base, `gps_device_id` debe quedar en null. Restaurarlo y volver a asignarle el equipo desde Editar.
3. Crear un vehículo nuevo con el mismo IMEI que la pickup → aparece el mensaje "Ese equipo GPS ya está asignado…". Cancelar.
4. **Restaurar** el Sedán: vuelve a "Activos".
5. En SQL: con un vehículo archivado, `select public.flota_request_reminders()` no lo incluye. Es opcional; ya está cubierto por los tests existentes del filtro `active`.

- [ ] **Step 3: README**

En la línea de **Vehículos** de la lista de funcionalidades, agregar al final: "Los vehículos fuera de uso se **archivan**: dejan de aparecer, pero conservan su historial y se pueden restaurar."

```bash
git add README.md
git commit -m "docs: archivar vehículos"
```

- [ ] **Step 4: Merge**

Merge `--no-ff` de `feature/archivar-vehiculos` a `main` y push.
