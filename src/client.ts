import { sign } from './signature.ts'
import {
  createPaymentToWire,
  parsePaymentRecord,
  parsePlan,
  type CreatePaymentInput,
  type Plan,
  type PaymentRecord,
} from './checkout.ts'

/**
 * Client for the Central API — invoicing (§9) and checkout (§10): product →
 * Central, signed with
 * the same token and scheme as the Bridge plus `X-Central-Product`.
 * Web standards only (fetch, crypto.subtle): runs on Workers, Vercel and Node.
 */

export interface IssueInvoiceInput {
  taker: { document: string; name: string; email?: string | null }
  amountCents: number
  description: string
  serviceCode?: string | null
  reference?: string | null
}

export interface CentralClientOptions {
  /** Central base URL (CENTRAL_URL), e.g. https://central.example.com */
  baseUrl: string
  /** Same token as CENTRAL_BRIDGE_TOKEN. */
  token: string
  /** Product slug (CENTRAL_BRIDGE_PRODUCT). */
  product: string
  /** Defaults to global fetch. */
  fetch?: typeof fetch
  /** Unix seconds. Defaults to Date.now(). */
  now?: () => number
  /** Request timeout in ms (default 30000). */
  timeoutMs?: number
}

/** Error returned by the Central (or a transport failure, status 0). */
export class CentralApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'CentralApiError'
    this.code = code
    this.status = status
  }
}

type ResponseKind = 'json' | 'buffer' | 'text'

export class CentralClient {
  #baseUrl: string
  #token: string
  #product: string
  #fetch: typeof fetch
  #now: () => number
  #timeoutMs: number

  constructor(options: CentralClientOptions) {
    if (!options.baseUrl) {
      throw new CentralApiError('invalid_config', 'Informe a URL da Central (CENTRAL_URL).', 0)
    }
    if (!options.token || !options.product) {
      throw new CentralApiError(
        'invalid_config',
        'Informe o token e o produto da Central (CENTRAL_BRIDGE_TOKEN / CENTRAL_BRIDGE_PRODUCT).',
        0
      )
    }
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.#token = options.token
    this.#product = options.product
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000))
    this.#timeoutMs = options.timeoutMs ?? 30_000
  }

  /** POST /api/v1/invoices */
  issueInvoice(input: IssueInvoiceInput, idempotencyKey: string): Promise<any> {
    return this.#request('POST', '/api/v1/invoices', 'json', {
      idempotencyKey,
      body: {
        taker: {
          document: input.taker.document,
          name: input.taker.name,
          ...(input.taker.email !== undefined ? { email: input.taker.email } : {}),
        },
        amount_cents: input.amountCents,
        description: input.description,
        ...(input.serviceCode !== undefined ? { service_code: input.serviceCode } : {}),
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
      },
    })
  }

  /** GET /api/v1/invoices?page= */
  listInvoices(page = 1): Promise<any> {
    return this.#request('GET', `/api/v1/invoices?page=${encodeURIComponent(String(page))}`, 'json')
  }

  /** GET /api/v1/invoices/{id} */
  getInvoice(id: string | number): Promise<any> {
    return this.#request('GET', `/api/v1/invoices/${encodeURIComponent(String(id))}`, 'json')
  }

  /** GET /api/v1/invoices/{id}/pdf → DANFSe bytes */
  invoicePdf(id: string | number): Promise<Uint8Array> {
    return this.#request('GET', `/api/v1/invoices/${encodeURIComponent(String(id))}/pdf`, 'buffer')
  }

  /** GET /api/v1/invoices/{id}/xml → authorized XML */
  invoiceXml(id: string | number): Promise<string> {
    return this.#request('GET', `/api/v1/invoices/${encodeURIComponent(String(id))}/xml`, 'text')
  }

  /** POST /api/v1/invoices/{id}/cancel — reason with 15–255 characters. */
  cancelInvoice(id: string | number, reason: string, idempotencyKey: string): Promise<any> {
    return this.#request(
      'POST',
      `/api/v1/invoices/${encodeURIComponent(String(id))}/cancel`,
      'json',
      { idempotencyKey, body: { reason } }
    )
  }

  /** GET /api/v1/plans — plans on sale, in display order (§10). */
  async listPlans(): Promise<Plan[]> {
    const body = await this.#request('GET', '/api/v1/plans', 'json')
    return (Array.isArray(body?.data) ? body.data : []).map(parsePlan)
  }

  /**
   * POST /api/v1/payments — the Central creates the charge with its own
   * gateway keys. Same key + same input returns the same payment; use a new
   * key for a new attempt (e.g. after `status: "failed"`).
   */
  async createPayment(input: CreatePaymentInput, idempotencyKey: string): Promise<PaymentRecord> {
    const body = await this.#request('POST', '/api/v1/payments', 'json', {
      idempotencyKey,
      body: createPaymentToWire(input),
    })
    return parsePaymentRecord(body?.data)
  }

  /** GET /api/v1/payments/{id} — current status (pending ones are re-checked at the gateway). */
  async getPayment(id: string): Promise<PaymentRecord> {
    const body = await this.#request(
      'GET',
      `/api/v1/payments/${encodeURIComponent(id)}`,
      'json'
    )
    return parsePaymentRecord(body?.data)
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    kind: ResponseKind,
    options: { body?: unknown; idempotencyKey?: string } = {}
  ): Promise<any> {
    const url = new URL(`${this.#baseUrl}${path}`)
    const pathWithQuery = `${url.pathname}${url.search}`
    const rawBody = options.body === undefined ? '' : JSON.stringify(options.body)
    const timestamp = String(this.#now())

    const headers: Record<string, string> = {
      'Accept': kind === 'json' ? 'application/json' : '*/*',
      'X-Central-Product': this.#product,
      'X-Central-Timestamp': timestamp,
      'X-Central-Signature': await sign(this.#token, method, pathWithQuery, timestamp, rawBody),
      'X-Central-Request-Id': crypto.randomUUID(),
    }
    if (rawBody) headers['Content-Type'] = 'application/json'
    if (method === 'POST') {
      const key = options.idempotencyKey ?? ''
      if (key.length < 1 || key.length > 128) {
        throw new CentralApiError(
          'validation_failed',
          'Informe uma chave de idempotência com 1 a 128 caracteres.',
          0
        )
      }
      headers['X-Idempotency-Key'] = key
    }

    let response: Response
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        body: rawBody || undefined,
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (error) {
      throw new CentralApiError(
        'network_error',
        `Não foi possível falar com a Central: ${(error as Error)?.message ?? String(error)}`,
        0
      )
    }

    if (!response.ok) throw await this.#toError(response)

    if (kind === 'buffer') return new Uint8Array(await response.arrayBuffer())
    if (kind === 'text') return response.text()
    const text = await response.text()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      throw new CentralApiError(
        'invalid_response',
        'A Central respondeu com um JSON inválido.',
        response.status
      )
    }
  }

  async #toError(response: Response): Promise<CentralApiError> {
    let code = response.status >= 500 ? 'internal_error' : 'http_error'
    let message = `A Central respondeu com HTTP ${response.status}.`
    try {
      const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } }
      if (body?.error && typeof body.error.code === 'string') code = body.error.code
      if (body?.error && typeof body.error.message === 'string') message = body.error.message
    } catch {
      // body is not JSON: keep the generic error
    }
    return new CentralApiError(code, message, response.status)
  }
}
