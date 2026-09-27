import { assert, assertEquals, assertRejects, assertStringIncludes } from 'jsr:@std/assert@1'
import { emailConfig, ResendHttpError, sendEmail } from '../_shared/resend.ts'
import { HttpError } from '../_shared/http.ts'

function withEnv(vars: Record<string, string>, fn: () => void) {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) prev[k] = Deno.env.get(k)
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v)
  try {
    fn()
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) Deno.env.delete(k)
      else Deno.env.set(k, prev[k]!)
    }
  }
}

Deno.test('emailConfig: quita saltos de línea de appName', () => {
  withEnv({
    RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.com', APP_URL: 'https://flota.test',
    APP_NAME: 'Línea uno\nLínea dos\r\nLínea tres',
  }, () => {
    const cfg = emailConfig()
    assertEquals(cfg.appName, 'Línea uno Línea dos Línea tres')
  })
})

Deno.test('emailConfig: APP_URL sin http(s) lanza HttpError 500', () => {
  withEnv({ RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.com', APP_URL: 'flota.test' }, () => {
    try {
      emailConfig()
      throw new Error('debía lanzar')
    } catch (err) {
      assert(err instanceof HttpError)
      assertEquals(err.status, 500)
      assertEquals(err.message, 'APP_URL debe empezar con http:// o https://')
    }
  })
})

Deno.test('emailConfig: APP_URL con https:// pasa', () => {
  withEnv({ RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.com', APP_URL: 'https://flota.test' }, () => {
    const cfg = emailConfig()
    assertEquals(cfg.appUrl, 'https://flota.test')
  })
})

const CFG = { apiKey: 'k', from: 'a@b.com', appUrl: 'https://flota.test', appName: 'Flota' }
const EMAIL = { to: ['x@y.com'], subject: 'Asunto', html: '<p>hola</p>', text: 'hola' }

Deno.test('sendEmail: !res.ok lanza ResendHttpError con el mismo mensaje', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (() =>
    Promise.resolve(new Response('cuerpo del error', { status: 422 }))) as typeof fetch
  try {
    const err = await assertRejects<ResendHttpError>(() => sendEmail(CFG, EMAIL), ResendHttpError)
    assertStringIncludes(err.message, 'Resend (422): cuerpo del error')
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('sendEmail: envía con AbortSignal.timeout', async () => {
  const original = globalThis.fetch
  let sawSignal: AbortSignal | undefined
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    sawSignal = init?.signal ?? undefined
    return Promise.resolve(new Response('ok', { status: 200 }))
  }) as typeof fetch
  try {
    await sendEmail(CFG, EMAIL)
    assert(sawSignal instanceof AbortSignal)
  } finally {
    globalThis.fetch = original
  }
})

Deno.test('sendEmail: un error de red se propaga sin envolver', async () => {
  const original = globalThis.fetch
  const networkError = new TypeError('network down')
  globalThis.fetch = (() => Promise.reject(networkError)) as typeof fetch
  try {
    const err = await assertRejects(() => sendEmail(CFG, EMAIL))
    assertEquals(err, networkError)
  } finally {
    globalThis.fetch = original
  }
})
