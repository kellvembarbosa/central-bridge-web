import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CentralApiError, CentralClient } from '../src/client.ts'
import { verifySignature } from '../src/signature.ts'
import { NOW, TOKEN } from './helpers.ts'

function fakeCentral(respond: (request: Request) => Response | Promise<Response>) {
  const seen: Request[] = []
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    seen.push(request.clone())
    return respond(request)
  }) as typeof globalThis.fetch
  const client = new CentralClient({
    baseUrl: 'https://central.test/',
    token: TOKEN,
    product: 'demo',
    fetch,
    now: () => NOW,
  })
  return { client, seen }
}

describe('CentralClient (product → Central)', () => {
  it('issueInvoice sends a body the Central verifies', async () => {
    const { client, seen } = fakeCentral(() => Response.json({ data: { id: 7 } }, { status: 201 }))
    const result = await client.issueInvoice(
      { taker: { document: '1', name: 'Ana' }, amountCents: 1990, description: 'Plano' },
      'inv-1'
    )
    assert.deepEqual(result, { data: { id: 7 } })

    const request = seen[0]
    const url = new URL(request.url)
    const body = await request.text()
    assert.equal(request.method, 'POST')
    assert.equal(url.pathname, '/api/v1/invoices')
    assert.equal(request.headers.get('x-central-product'), 'demo')
    assert.equal(request.headers.get('x-idempotency-key'), 'inv-1')
    assert.deepEqual(JSON.parse(body), {
      taker: { document: '1', name: 'Ana' },
      amount_cents: 1990,
      description: 'Plano',
    })
    assert.equal(
      await verifySignature({
        token: TOKEN,
        method: 'POST',
        pathWithQuery: url.pathname + url.search,
        rawBody: body,
        timestamp: request.headers.get('x-central-timestamp'),
        signature: request.headers.get('x-central-signature'),
        now: NOW,
      }),
      'valid'
    )
  })

  it('pdf → bytes, xml → text, query is part of the signed path', async () => {
    const { client, seen } = fakeCentral((request) => {
      const path = new URL(request.url).pathname
      if (path.endsWith('/pdf')) return new Response(new Uint8Array([37, 80, 68, 70]))
      if (path.endsWith('/xml')) return new Response('<NFSe/>')
      return Response.json({ data: [] })
    })
    assert.deepEqual(await client.invoicePdf(3), new Uint8Array([37, 80, 68, 70]))
    assert.equal(await client.invoiceXml(3), '<NFSe/>')
    await client.listInvoices(2)
    const list = seen[2]
    const url = new URL(list.url)
    assert.equal(url.search, '?page=2')
    assert.equal(
      await verifySignature({
        token: TOKEN,
        method: 'GET',
        pathWithQuery: url.pathname + url.search,
        rawBody: '',
        timestamp: list.headers.get('x-central-timestamp'),
        signature: list.headers.get('x-central-signature'),
        now: NOW,
      }),
      'valid'
    )
  })

  it('maps Central errors, requires an idempotency key on writes', async () => {
    const { client } = fakeCentral(() =>
      Response.json(
        { error: { code: 'validation_failed', message: 'Motivo curto.' } },
        { status: 422 }
      )
    )
    await assert.rejects(client.cancelInvoice(1, 'curto', 'k'), (error: CentralApiError) => {
      assert.equal(error.code, 'validation_failed')
      assert.equal(error.status, 422)
      return true
    })
    await assert.rejects(client.cancelInvoice(1, 'x'.repeat(20), ''), /idempotência/)
  })
})
