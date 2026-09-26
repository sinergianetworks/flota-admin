import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from './supabase'

// Invoca una edge function y devuelve el JSON. Si la función responde con
// error, lanza con el mensaje de { error } en vez del genérico de supabase-js.
export async function invokeFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body })
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const payload = await error.context.json().catch(() => null)
      throw new Error(payload?.error ?? error.message)
    }
    throw error
  }
  return data as T
}
