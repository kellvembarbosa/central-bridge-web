import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CentralClient } from '../src/client.ts'
import {
  parsePaymentEvent,
  parsePaymentRecord,
  parsePlan,
  type PaymentEvent,
} from '../src/checkout.ts'
import { ValidationFailedError } from '../src/errors.ts'
import { verifySignature } from '../src/signature.ts'
import { ACTOR, NOW, TOKEN, makeBridge, readVectors, signedRequest, writeRequest } from './helpers.ts'

const vectors = readVectors<{
  plan_wire: unknown
  plan_parsed: unknown
  payment_wire: unknown
  payment_parsed: unknown
  event_wire: Record<string, unknown>
  event_parsed: unknown
  renewal_wire: Record<string, unknown>
  renewal_parsed: unknown
  prepaid_wire: Record<string, unknown>
  prepaid_parsed: unknown
  invalid_events: { why: string; wire: Record<string, unknown> }[]
}>('payment_event.json')

describe('checkout vectors (bridge-test-vectors/payment_event.json)', () => {
  it('plan, payment and events parse to the camelCase shapes', () => {
    assert.deepEqual(parsePlan(vectors.plan_wire), vectors.plan_parsed)
    assert.deepEqual(parsePaymentRecord(vectors.payment_wire), vectors.payment_parsed)
    assert.deepEqual(parsePaymentEvent(vectors.event_wire), vectors.event_parsed)
    assert.deepEqual(parsePaymentEvent(vectors.renewal_wire), vectors.renewal_parsed)
    assert.deepEqual(parsePaymentEvent(vectors.prepaid_wire), vectors.prepaid_parsed)
  })

  it('accessUntil: null when an older Central omits it, 422 when it is not a string', () => {
    const { access_until: _omitted, ...older } = vectors.payment_wire as Record<string, unknown>
    assert.equal(parsePaymentRecord(older).accessUntil, null)
    assert.throws(() => parsePaymentRecord({ ...older, access_until: 123 }), ValidationFailedError)
  })

  for (const bad of vectors.invalid_events) {
    it(`rejects: ${bad.why}`, () => {
      assert.throws(() => parsePaymentEvent(bad.wire), ValidationFailedError)
    })
  }
})

describe('POST payment-events (Central → product)', () => {
  it('delivers the parsed event with the actor; announces payment_events', async () => {
    const received: { event: PaymentEvent; actor: string }[] = []
    const bridge = makeBridge({
      handlers: {
        paymentEvent: (event, actor) => {
          received.push({ event, actor })
        },
      },
    })
    const res = await bridge.call(
      await writeRequest('/central-api/v1/payment-events', vectors.event_wire, 'evt-key')
    )
    assert.equal(res!.status, 200)
    assert.deepEqual(res!.body, { ok: true })
    assert.deepEqual(received, [{ event: vectors.event_parsed, actor: ACTOR }])

    // Same event again (retry after a lost response): replayed, handler not called.
    const again = await bridge.call(
      await writeRequest('/central-api/v1/payment-events', vectors.event_wire, 'evt-key')
    )
    assert.equal(again!.headers.get('x-idempotency-replayed'), 'true')
    assert.equal(received.length, 1)

    const health = await bridge.call(await signedRequest('GET', '/central-api/v1/health'))
    assert.ok(health!.body.capabilities.includes('payment_events'))
  })

  it('422 on an invalid event, 501 without the handler', async () => {
    const bridge = makeBridge({ handlers: { paymentEvent: () => {} } })
    const bad = await bridge.call(
      await writeRequest('/central-api/v1/payment-events', vectors.invalid_events[0].wire, 'k-bad')
    )
    assert.equal(bad!.status, 422)
    assert.equal(bad!.body.error.code, 'validation_failed')

    const none = makeBridge()
    const res = await none.call(
      await writeRequest('/central-api/v1/payment-events', vectors.event_wire, 'k-none')
    )
    assert.equal(res!.status, 501)
    assert.equal(res!.body.error.code, 'capability_unsupported')
  })
})

describe('CentralClient checkout (product → Central)', () => {
  function fakeCentral(respond: (request: Request) => Response) {
    const seen: Request[] = []
    const client = new CentralClient({
      baseUrl: 'https://central.test',
      token: TOKEN,
      product: 'demo',
      now: () => NOW,
      fetch: (async (input: string | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        seen.push(request.clone())
        return respond(request)
      }) as typeof fetch,
    })
    return { client, seen }
  }

  it('listPlans, createPayment and getPayment map the wire shapes', async () => {
    const { client, seen } = fakeCentral((request) => {
      const path = new URL(request.url).pathname
      if (path === '/api/v1/plans') return Response.json({ data: [vectors.plan_wire] })
      return Response.json({ data: vectors.payment_wire }, { status: request.method === 'POST' ? 201 : 200 })
    })

    assert.deepEqual(await client.listPlans(), [vectors.plan_parsed])

    const created = await client.createPayment(
      {
        plan: 'vitalicio',
        customer: { name: 'Ana Souza', email: 'ana@cliente.test', document: '52998224725' },
        productUserRef: '42',
        method: 'pix',
        tracking: { utm_source: 'google' },
      },
      'checkout-1'
    )
    assert.deepEqual(created, vectors.payment_parsed)

    const post = seen[1]
    const body = await post.text()
    assert.equal(post.headers.get('x-idempotency-key'), 'checkout-1')
    assert.deepEqual(JSON.parse(body), {
      plan: 'vitalicio',
      customer: { name: 'Ana Souza', email: 'ana@cliente.test', document: '52998224725' },
      product_user_ref: '42',
      method: 'pix',
      tracking: { utm_source: 'google' },
    })
    assert.equal(
      await verifySignature({
        token: TOKEN,
        method: 'POST',
        pathWithQuery: '/api/v1/payments',
        rawBody: new TextEncoder().encode(body),
        timestamp: post.headers.get('x-central-timestamp'),
        signature: post.headers.get('x-central-signature'),
        now: NOW,
      }),
      'valid'
    )

    assert.deepEqual(await client.getPayment('7f6d/../x'), vectors.payment_parsed)
    assert.equal(new URL(seen[2].url).pathname, '/api/v1/payments/7f6d%2F..%2Fx')
  })

  it('surfaces Central errors (plan_unavailable)', async () => {
    const { client } = fakeCentral(() =>
      Response.json(
        { error: { code: 'plan_unavailable', message: 'Plano inexistente ou fora de venda.' } },
        { status: 422 }
      )
    )
    await assert.rejects(
      client.createPayment(
        { plan: 'x', customer: { name: 'A', email: 'a@b.c' }, productUserRef: '1' },
        'k'
      ),
      (error: any) => error.code === 'plan_unavailable' && error.status === 422
    )
  })
})
