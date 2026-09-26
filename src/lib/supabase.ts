import { createClient } from '@supabase/supabase-js'
import { config } from './config'

// Si falta la configuración se usa una URL de relleno para que createClient no
// lance al importar; main.tsx muestra la pantalla de configuración incompleta.
export const supabase = createClient(
  config.supabaseUrl || 'http://localhost',
  config.supabaseKey || 'sb_publishable_placeholder',
)
