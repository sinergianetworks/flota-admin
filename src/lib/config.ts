// Configuración de la instalación.
//
// Las variables VITE_* se congelan al compilar, así que no sirven para que una
// misma imagen Docker atienda a varias instalaciones. Por eso primero se lee
// window.__ENV__, que el contenedor genera al arrancar en /env-config.js, y solo
// si falta se usa la variable VITE_* (útil en desarrollo con .env.local).

const runtime = window.__ENV__ ?? {}
const buildTime = import.meta.env as unknown as Record<string, string | undefined>

function read(key: string): string {
  const value = runtime[key] ?? buildTime[`VITE_${key}`]
  return typeof value === 'string' ? value.trim() : ''
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const timezone = read('APP_TIMEZONE')

export const config = {
  supabaseUrl: read('SUPABASE_URL'),
  supabaseAnonKey: read('SUPABASE_ANON_KEY'),
  appName: read('APP_NAME') || 'Flota Admin',
  logoUrl: read('APP_LOGO_URL') || '/logo.svg',
  primaryColor: read('APP_PRIMARY_COLOR'),
  // Debe coincidir con APP_TIMEZONE de las edge functions: define qué es "hoy"
  // al agrupar los km por día.
  timezone: timezone && isValidTimeZone(timezone) ? timezone : 'UTC',
  currency: read('APP_CURRENCY') || '$',
}

// Lista de variables obligatorias que faltan; si no está vacía la app muestra
// una pantalla de configuración en vez de fallar con errores de red.
export const missingConfig: string[] = [
  !config.supabaseUrl && 'SUPABASE_URL',
  !config.supabaseAnonKey && 'SUPABASE_ANON_KEY',
  !timezone && 'APP_TIMEZONE',
  timezone && !isValidTimeZone(timezone) && 'APP_TIMEZONE (zona horaria inválida)',
].filter((v): v is string => Boolean(v))
