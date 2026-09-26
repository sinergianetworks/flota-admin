// Utilidades HTTP comunes a todas las edge functions.

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

export function errorResponse(message: string, status: number): Response {
  return json({ error: message }, status)
}

// Error con código HTTP: se lanza desde cualquier punto y el handler lo
// convierte en respuesta.
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    const body = await req.json()
    return (body && typeof body === 'object' ? body : {}) as T
  } catch {
    return {} as T
  }
}

type Handler = (req: Request) => Promise<Response>

// Envuelve un handler: responde el preflight CORS, acepta solo POST y
// traduce errores a JSON { error }. Separado de serve() para poder testearlo.
export function withErrors(handler: Handler): Handler {
  return async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
    if (req.method !== 'POST') return errorResponse('Método no permitido', 405)
    try {
      return await handler(req)
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err.message, err.status)
      console.error(err)
      return errorResponse('Error interno del servidor', 500)
    }
  }
}

export function serve(handler: Handler) {
  Deno.serve(withErrors(handler))
}
