export default function ConfigMissingPage({ missing }: { missing: string[] }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white border rounded-2xl p-6 space-y-3">
        <h1 className="text-lg font-semibold">Configuración incompleta</h1>
        <p className="text-sm text-muted-foreground">
          Faltan estas variables de entorno en la instalación:
        </p>
        <ul className="text-sm font-mono bg-gray-50 border rounded-lg p-3 space-y-1">
          {missing.map(m => <li key={m}>{m}</li>)}
        </ul>
        <p className="text-sm text-muted-foreground">
          Defínelas en el contenedor (o en <code>.env.local</code> con prefijo <code>VITE_</code> en
          desarrollo) y vuelve a cargar la página. Consulta <code>docs/INSTALACION.md</code>.
        </p>
      </div>
    </div>
  )
}
