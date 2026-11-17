// Runs inside workerd (Miniflare) with a real D1 binding. Driven by
// tests/workerd/run.mjs; not part of `npm test` (needs miniflare).
import {
  createCentralBridge,
  cloudflareIp,
  sign,
  verifySignature,
  D1IdempotencyStore,
  D1_IDEMPOTENCY_SCHEMA,
  type D1Like,
} from '../../src/index.ts'
// Resolved by run.mjs (esbuild alias) to ./test-vectors or ../bridge-test-vectors.
// @ts-expect-error virtual module
import signatureVectors from 'bridge-test-vectors/signature.json'

interface Env {
  DB: D1Like & { exec(sql: string): Promise<unknown> }
}

const TOKEN = 'cbt_test_token_0123456789abcdef'

async function signed(method: string, path: string, body = '', extra: Record<string, string> = {}) {
  const ts = Math.floor(Date.now() / 1000)
  return new Request(`https://product.test${path}`, {
    method,
    body: body || undefined,
    headers: {
      'X-Central-Timestamp': String(ts),
      'X-Central-Signature': await sign(TOKEN, method, path, ts, body),
      'cf-connecting-ip': '10.0.0.1',
      ...extra,
    },
  })
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const checks: Record<string, unknown> = {}

    for (const v of signatureVectors.cases) {
      checks[`vector:${v.name}`] =
        (await verifySignature({
          token: signatureVectors.token,
          method: v.method,
          pathWithQuery: v.path,
          rawBody: v.body,
          timestamp: String(v.timestamp),
          signature: v.signature,
          now: v.now,
        })) === v.expect
    }

    await env.DB.exec(D1_IDEMPOTENCY_SCHEMA.replace(/\n\s*/g, ' '))
    let runs = 0
    const bridge = createCentralBridge({
      enabled: true,
      token: TOKEN,
      product: 'demo',
      allowedIps: '10.0.0.1',
      getClientIp: cloudflareIp,
      idempotencyStore: new D1IdempotencyStore(env.DB),
      handlers: { suspend: async () => void runs++, unsuspend: async () => {} },
    })

    checks.health = (await bridge(await signed('GET', '/central-api/v1/health')))?.status === 200
    const write = () =>
      signed('POST', '/central-api/v1/users/u1/suspend', '{"reason":"x"}', {
        'X-Central-Actor': 'ops@central.test',
        'X-Idempotency-Key': 'k1',
      })
    const first = await bridge(await write())
    const second = await bridge(await write())
    checks.writeOk = first?.status === 200
    checks.replayed = second?.headers.get('x-idempotency-replayed') === 'true'
    checks.ranOnce = runs === 1
    const badIp = await signed('GET', '/central-api/v1/health', '', {
      'cf-connecting-ip': '1.2.3.4',
    })
    checks.ipDenied = (await bridge(badIp))?.status === 403
    checks.fallthrough = (await bridge(new Request('https://product.test/'))) === null

    return Response.json(checks)
  },
}
