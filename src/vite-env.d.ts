/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_APP_NAME?: string
  readonly VITE_APP_LOGO_URL?: string
  readonly VITE_APP_PRIMARY_COLOR?: string
  readonly VITE_APP_TIMEZONE?: string
  readonly VITE_APP_CURRENCY?: string
}

interface Window {
  __ENV__?: Record<string, string | undefined>
}
