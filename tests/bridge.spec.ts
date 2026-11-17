import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cloudflareIp, nodeSocketIp, vercelIp } from '../src/ip.ts'
import type { BridgeHandlers } from '../src/types.ts'
import {
  ACTOR,
  NOW,
  ORIGIN,
  centralSignerAvailable,
  makeBridge,
  signedRequest,
  writeRequest,
} from './helpers.ts'

const users: BridgeHandlers = {
  searchUsers: (q, page, perPage) => ({
    data: [
      {
        ref: 'u1',
        email: q,
        name: 'Ana',
        plan: 'pro',
        suspended: false,
        createdAt: new Date(Date.UTC(2025, 0, 2)),
        lastSeenAt: null,
        // forbidden keys must never leave the product
        ...({ password_hash: 'x', apiToken: 'y' } as object),
      },
    ],
    hasMore: page * perPage < 100,
  }),
  invoiceRequest: (provider, paymentId) => ({
    requested: true,
    requestRef: `${provider}:${paymentId}`,
    email: 'a@b.c',
    serviceDescription: 'Plano',
    taker: { document: '12345678900', name: 'Ana' },
  }),
}

describe('routing', () => {
  it('returns null outside the base path so the host app falls through', async () => {
    const bridge = makeBridge()
    assert.equal(await bridge.handle(new Request(`${ORIGIN}/`)), null)
    assert.equal(await bridge.handle(new Request(`${ORIGIN}/central-api/v10/health`)), null)
    assert.equal(await bridge.handle(new Request(`${ORIGIN}/central-api`)), null)
  })

  it('custom base path', async () => {
    const bridge = makeBridge({ basePath: '/app/central-api/v1/' })
    const res = await bridge.call(await signedRequest('GET', '/app/central-api/v1/health'))
    assert.equal(res?.status, 200)
    assert.equal(await bridge.handle(await signedRequest('GET', '/central-api/v1/health')), null)
  })

  it('unknown route or wrong method under the base path → 404 after auth', async () => {
    const bridge = makeBridge()
    assert.equal(
      (await bridge.call(await signedRequest('GET', '/central-api/v1/nope')))?.body.error.code,
      'not_found'
    )
    assert.equal(
      (await bridge.call(await signedRequest('POST', '/central-api/v1/health')))?.status,
      404
    )
    // unsigned unknown route still answers unauthorized first
    assert.equal(
      (await bridge.call(await signedRequest('GET', '/central-api/v1/nope', { unsigned: true })))
        ?.status,
      401
    )
  })
})

describe('check order: disabled → IP → unauthorized → skew → signature', () => {
  it('disabled → 404 even from a forbidden IP without signature', async () => {
    const bridge = makeBridge({ enabled: false, allowedIps: '10.0.0.1' })
    const res = await bridge.call(
      await signedRequest('GET', '/central-api/v1/health', { unsigned: true })
    )
    assert.equal(res?.status, 404)
    assert.equal(res?.body.error.code, 'not_found')
  })

  it('IP not allowed → 403 before signature checks', async () => {
    const bridge = makeBridge({ allowedIps: '10.0.0.1', getClientIp: cloudflareIp })
    const res = await bridge.call(
      await signedRequest('GET', '/central-api/v1/health', {
        unsigned: true,
        headers: { 'cf-connecting-ip': '10.0.0.2' },
      })
    )
    assert.equal(res?.status, 403)
    assert.equal(res?.body.error.code, 'ip_not_allowed')
  })

  it('allowedIps without getClientIp fails closed, even signed', async () => {
    const bridge = makeBridge({ allowedIps: ['10.0.0.1'] })
    const res = await bridge.call(
      await signedRequest('GET', '/central-api/v1/health', {
        headers: { 'x-forwarded-for': '10.0.0.1', 'cf-connecting-ip': '10.0.0.1' },
      })
    )
    assert.equal(res?.status, 403)
  })

  it('x-forwarded-for is never trusted by the presets', async () => {
    for (const getClientIp of [cloudflareIp, vercelIp, nodeSocketIp]) {
      const bridge = makeBridge({ allowedIps: '10.0.0.1', getClientIp })
      const res = await bridge.call(
        await signedRequest('GET', '/central-api/v1/health', {
          headers: { 'x-forwarded-for': '10.0.0.1' },
        })
      )
      assert.equal(res?.status, 403)
    }
  })

  it('IP presets accept the platform header / socket address', async () => {
    const cases: Array<
      [Parameters<typeof makeBridge>[0], Record<string, string>, { clientIp?: string }?]
    > = [
      [{ getClientIp: cloudflareIp }, { 'cf-connecting-ip': '10.0.0.1' }],
      [{ getClientIp: vercelIp }, { 'x-real-ip': '10.0.0.1' }],
      [{ getClientIp: vercelIp }, { 'x-vercel-forwarded-for': '10.0.0.1, 1.1.1.1' }],
      [{ getClientIp: nodeSocketIp }, {}, { clientIp: '::ffff:10.0.0.1' }],
    ]
    for (const [options, headers, context] of cases) {
      const bridge = makeBridge({ allowedIps: ' 10.0.0.1 , 10.0.0.9', ...options })
      const res = await bridge.call(
        await signedRequest('GET', '/central-api/v1/health', { headers }),
        context
      )
      assert.equal(res?.status, 200, JSON.stringify(headers))
    }
  })

  it('missing signature / bad timestamp / no token configured → unauthorized', async () => {
    const bridge = makeBridge()
    for (const request of [
      await signedRequest('GET', '/central-api/v1/health', { unsigned: true }),
      await signedRequest('GET', '/central-api/v1/health', { timestamp: '17632e5' }),
    ]) {
      const res = await bridge.call(request)
      assert.equal(res?.status, 401)
      assert.equal(res?.body.error.code, 'unauthorized')
    }
    const noToken = makeBridge({ token: '' })
    assert.equal(
      (await noToken.call(await signedRequest('GET', '/central-api/v1/health')))?.body.error.code,
      'unauthorized'
    )
  })

  it('clock skew → timestamp_skew', async () => {
    const bridge = makeBridge()
    const res = await bridge.call(
      await signedRequest('GET', '/central-api/v1/health', { timestamp: NOW - 301 })
    )
    assert.equal(res?.status, 401)
    assert.equal(res?.body.error.code, 'timestamp_skew')
    const edge = await bridge.call(
      await signedRequest('GET', '/central-api/v1/health', { timestamp: NOW + 300 })
    )
    assert.equal(edge?.status, 200)
  })

  it('tampered path, query, body, token or malformed hex → signature_invalid', async () => {
    const bridge = makeBridge({ handlers: users, idempotencyStore: undefined })
    const requests = [
      await signedRequest('GET', '/central-api/v1/users?q=ana', {
        signPath: '/central-api/v1/users?q=bob',
      }),
      await signedRequest('GET', '/central-api/v1/health', { token: 'other-token' }),
      await signedRequest('POST', '/central-api/v1/users/u1/suspend', {
        body: '{"reason":"a"}',
        signBody: '{"reason":"b"}',
      }),
      await signedRequest('GET', '/central-api/v1/health', { signature: 'not-hex' }),
      await signedRequest('GET', '/central-api/v1/health', { signature: 'ab'.repeat(31) }),
    ]
    for (const request of requests) {
      const res = await bridge.call(request)
      assert.equal(res?.status, 401)
      assert.equal(res?.body.error.code, 'signature_invalid')
    }
  })

  it('oversized body → 422 without reading it all', async () => {
    const bridge = makeBridge({ maxBodyBytes: 16 })
    const res = await bridge.call(
      await writeRequest('/central-api/v1/users/u1/suspend', { reason: 'x'.repeat(64) })
    )
    assert.equal(res?.status, 422)
  })
})

describe('signed round trip (Central signRequest → bridge)', () => {
  it(`signer: ${centralSignerAvailable ? "Central's app/services/bridge_signature.ts" : 'package sign()'}`, () => {
    assert.ok(true)
  })

  it('health reports product, version and capabilities', async () => {
    const bridge = makeBridge({ handlers: users })
    const res = await bridge.call(
      await signedRequest('GET', '/central-api/v1/health', {
        headers: { 'X-Central-Request-Id': 'req-1' },
      })
    )
    assert.equal(res?.status, 200)
    assert.deepEqual(res?.body, {
      version: '1.0.0',
      product: 'demo',
      capabilities: ['users_search'],
    })
    assert.equal(res?.headers.get('cache-control'), 'no-store')
    assert.equal(res?.headers.get('x-central-request-id'), 'req-1')
  })

  it('raw encoded query is verified and decoded for the handler; secrets dropped', async () => {
    const bridge = makeBridge({ handlers: users })
    const res = await bridge.call(
      await signedRequest('GET', '/central-api/v1/users?q=ana%40x.com&page=2')
    )
    assert.equal(res?.status, 200)
    assert.deepEqual(res?.body, {
      data: [
        {
          ref: 'u1',
          email: 'ana@x.com',
          name: 'Ana',
          plan: 'pro',
          suspended: false,
          created_at: '2025-01-02T00:00:00.000Z',
          last_seen_at: null,
        },
      ],
      page: 2,
      per_page: 25,
      has_more: true,
    })
  })

  it('invoice-request keeps taker.document (only allowed path)', async () => {
    const bridge = makeBridge({ handlers: users })
    const res = await bridge.call(
      await signedRequest('GET', '/central-api/v1/payments/stripe/pi%2F1/invoice-request')
    )
    assert.equal(res?.status, 200)
    assert.equal(res?.body.request_ref, 'stripe:pi/1')
    assert.deepEqual(res?.body.taker, { document: '12345678900', name: 'Ana' })
  })

  it('getSignedPath: a rewrite changed the URL, the original signed path is used', async () => {
    const bridge = makeBridge({
      handlers: users,
      getSignedPath: (request) => request.headers.get('x-original-path') ?? '',
    })
    const signed = await signedRequest('GET', '/central-api/v1/health')
    const rewritten = new Request(`${ORIGIN}/api/bridge?route=health`, {
      headers: {
        ...Object.fromEntries(signed.headers),
        'x-original-path': '/central-api/v1/health',
      },
    })
    assert.equal((await bridge.call(rewritten))?.status, 200)
  })

  it('missing handler → 501; validation → 422; handler crash → 500 without details', async () => {
    const bridge = makeBridge({
      handlers: {
        findUser: () => {
          throw new Error('db password leaked in message')
        },
      },
    })
    const unsupported = await bridge.call(
      await signedRequest('GET', '/central-api/v1/metrics?from=2025-01-01&to=2025-01-02')
    )
    assert.equal(unsupported?.status, 501)
    assert.equal(unsupported?.body.error.code, 'capability_unsupported')

    const withSearch = makeBridge({ handlers: users })
    const invalid = await withSearch.call(
      await signedRequest('GET', '/central-api/v1/users?page=0')
    )
    assert.equal(invalid?.status, 422)

    const crash = await bridge.call(await signedRequest('GET', '/central-api/v1/users/u1'))
    assert.equal(crash?.status, 500)
    assert.deepEqual(crash?.body, {
      error: { code: 'internal_error', message: 'Erro interno no produto.' },
    })
    assert.equal(bridge.errors.length, 1)
  })
})

describe('writes: actor + idempotency', () => {
  function suspendBridge(overrides: Parameters<typeof makeBridge>[0] = {}) {
    const calls: Array<[string, string, string]> = []
    const bridge = makeBridge({
      handlers: {
        suspend: async (ref, reason, actor) => {
          calls.push([ref, reason, actor])
        },
        unsuspend: async () => {},
      },
      ...overrides,
    })
    return { bridge, calls }
  }

  it('runs the handler with the parsed body and actor', async () => {
    const { bridge, calls } = suspendBridge()
    const res = await bridge.call(
      await writeRequest('/central-api/v1/users/u_42/suspend', { reason: 'Fraude' })
    )
    assert.equal(res?.status, 200)
    assert.deepEqual(res?.body, { ok: true })
    assert.deepEqual(calls, [['u_42', 'Fraude', ACTOR]])
  })

  it('missing/invalid actor → 422 missing_actor; missing key → 422 validation_failed', async () => {
    const { bridge, calls } = suspendBridge()
    const noActor = await bridge.call(
      await writeRequest('/central-api/v1/users/u1/suspend', { reason: 'x' }, 'k', {
        'X-Central-Actor': 'nope',
      })
    )
    assert.equal(noActor?.body.error.code, 'missing_actor')
    const noKey = await bridge.call(
      await writeRequest('/central-api/v1/users/u1/suspend', { reason: 'x' }, '')
    )
    assert.equal(noKey?.status, 422)
    assert.equal(noKey?.body.error.code, 'validation_failed')
    assert.equal(calls.length, 0)
  })

  it('no idempotency store → writes refused (500), reads still work', async () => {
    const { bridge, calls } = suspendBridge({ idempotencyStore: undefined })
    const res = await bridge.call(
      await writeRequest('/central-api/v1/users/u1/suspend', { reason: 'x' })
    )
    assert.equal(res?.status, 500)
    assert.equal(res?.body.error.code, 'internal_error')
    assert.equal(calls.length, 0)
    assert.equal(
      (await bridge.call(await signedRequest('GET', '/central-api/v1/health')))?.status,
      200
    )
  })

  it('same key + same body → stored response replayed, handler runs once', async () => {
    const { bridge, calls } = suspendBridge()
    const first = await bridge.call(
      await writeRequest('/central-api/v1/users/u1/suspend', { reason: 'x' })
    )
    const second = await bridge.call(
      await writeRequest('/central-api/v1/users/u1/suspend', { reason: 'x' })
    )
    assert.equal(first?.headers.get('x-idempotency-replayed'), null)
    assert.equal(second?.status, 200)
    assert.deepEqual(second?.body, first?.body)
    assert.equal(second?.headers.get('x-idempotency-replayed'), 'true')
    assert.equal(calls.length, 1)
  })

  it('same key + different body or path → 409 idempotency_conflict', async () => {
    const { bridge, calls } = suspendBridge()
    await bridge.call(await writeRequest('/central-api/v1/users/u1/suspend', { reason: 'x' }))
    const otherBody = await bridge.call(
      await writeRequest('/central-api/v1/users/u1/suspend', { reason: 'y' })
    )
    const otherPath = await bridge.call(
      await writeRequest('/central-api/v1/users/u2/suspend', { reason: 'x' })
    )
    for (const res of [otherBody, otherPath]) {
      assert.equal(res?.status, 409)
      assert.equal(res?.body.error.code, 'idempotency_conflict')
    }
    assert.equal(calls.length, 1)
  })

  it('same key still running → 409 with the in-progress message', async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => (finish = resolve))
    let runs = 0
    const bridge = makeBridge({
      handlers: {
        suspend: async () => {
          runs++
          await gate
        },
        unsuspend: async () => {},
      },
    })
    const first = bridge.call(
      await writeRequest('/central-api/v1/users/u1/suspend', { reason: 'x' })
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = await bridge.call(
      await writeRequest('/central-api/v1/users/u1/suspend', { reason: 'x' })
    )
    assert.equal(second?.status, 409)
    assert.equal(
      second?.body.error.message,
      'Outra requisição com esta chave de idempotência ainda está em andamento.'
    )
    finish()
    assert.equal((await first)?.status, 200)
    assert.equal(runs, 1)
  })

  it('5xx responses are not stored: a retry runs again', async () => {
    let runs = 0
    const bridge = makeBridge({
      handlers: {
        suspend: async () => {
          if (runs++ === 0) throw new Error('transient')
        },
        unsuspend: async () => {},
      },
    })
    assert.equal(
      (await bridge.call(await writeRequest('/central-api/v1/users/u1/suspend', { reason: 'x' })))
        ?.status,
      500
    )
    assert.equal(
      (await bridge.call(await writeRequest('/central-api/v1/users/u1/suspend', { reason: 'x' })))
        ?.status,
      200
    )
    assert.equal(runs, 2)
  })

  it('4xx responses are stored and replayed', async () => {
    const { bridge, calls } = suspendBridge()
    const first = await bridge.call(
      await writeRequest('/central-api/v1/users/u1/suspend', { reason: '' })
    )
    const second = await bridge.call(
      await writeRequest('/central-api/v1/users/u1/suspend', { reason: '' })
    )
    assert.equal(first?.status, 422)
    assert.equal(second?.status, 422)
    assert.equal(second?.headers.get('x-idempotency-replayed'), 'true')
    assert.equal(calls.length, 0)
  })
})
