# Archivar vehículos — Diseño

**Fecha:** 2026-09-27
**Estado:** aprobado

## Objetivo

Permitir que el admin **archive** un vehículo que ya no está en uso, sin borrar su historial, y lo **restaure** cuando haga falta, igual que el archivado de Odoo.

## Comportamiento

- **Archivar:** botón "Archivar" en el modal de edición (solo admin, solo vehículos activos). Pide confirmación:
  > "El vehículo dejará de aparecer en la flota, en el GPS y en los correos. Su historial se conserva y puedes restaurarlo cuando quieras."
  - Si el vehículo tiene GPS, la confirmación incluye la casilla **"Liberar el equipo GPS ({proveedor} · {id}) para usarlo en otro vehículo"**, desmarcada por defecto. Si se marca, se borran `gps_provider` y `gps_device_id`.
  - Se guarda `active = false`. El conductor asignado se conserva.
- **Filtro del admin:** en la pantalla de vehículos, un selector **"Activos / Archivados"**. Por defecto, "Activos".
  - En la vista de archivados:
    - Las tarjetas se ven atenuadas y llevan la etiqueta "Archivado" en lugar del estado GPS.
    - No aparecen los botones Mapa, Recorrido ni Agregar. Sí están la Bitácora, que se puede consultar, y Editar.
    - Hay un botón **"Restaurar"**, que vuelve a poner `active = true`.
    - No se consulta el estado GPS en vivo ni se refresca cada minuto.
  - Si no hay archivados: "No hay vehículos archivados."
- **El conductor** no ve el selector. Su RLS ya oculta los vehículos inactivos.
- **Equipo GPS ya asignado:** si al guardar un vehículo el equipo GPS ya está en otro (restricción única `vehicles_gps_device_uidx`, código `23505`), se muestra:
  > "Ese equipo GPS ya está asignado a otro vehículo (puede estar archivado). Libéralo en ese vehículo o elige otro."

## Lo que ya funciona sin cambios

Los vehículos con `active = false` ya quedan fuera de:
- la RLS del conductor y del storage (`can_access_vehicle`);
- `gps-status` (`live`);
- `sync-mileage`;
- `send-reminders`, `send-weekly-report` y `vehicle_odometer` (el cálculo filtra los activos).

**No hace falta migración.**

## Fuera de alcance

Borrado definitivo, archivar desde la tarjeta sin abrir el modal, archivar varios a la vez y mostrar el autor de la bitácora al conductor (el usuario decidió dejarlo como está).
