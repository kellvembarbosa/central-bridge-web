import {
  BridgeError,
  IDEMPOTENCY_IN_PROGRESS_MESSAGE,
  UserNotFoundError,
  ValidationFailedError,
  errorBody,
  type BridgeErrorCode,
} from './errors.ts'
import {
  idempotencyFingerprint,
  type IdempotencyRecord,
  type IdempotencyStore,
} from './idempotency.ts'
import { normalizeIp, parseIps, type BridgeCallContext, type ClientIpResolver } from './ip.ts'
import { sanitize } from './sanitizer.ts'
import {
  invoiceRequestToWire,
  isValidDate,
  metricsToWire,
  pageToWire,
  parseInvoiceDelivery,
  parsePlanChange,
  parseReason,
  paymentOwnerToWire,
  subscriptionToWire,
  userDetailToWire,
  userSummaryToWire,
} from './serializers.ts'
import { DEFAULT_MAX_SKEW_SECONDS, verifySignature } from './signature.ts'
import {
  SUBSCRIPTION_STATUSES,
  type BridgeHandlers,
  type BridgeLogger,
  type Capability,
  type HandlersSource,
  type HealthResponse,
  type SubscriptionStatus,
} from './types.ts'
import {
  BRIDGE_VERSION,
  DEFAULT_BASE_PATH,
  DEFAULT_IDEMPOTENCY_TTL_HOURS,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_PER_PAGE,
} from './version.ts'

export interface CentralBridgeOptions {
  /** CENTRAL_BRIDGE_ENABLED. Disabled → every Bridge path answers 404 `not_found`. */
  enabled: boolean
  /** CENTRAL_BRIDGE_TOKEN — a server secret. Never expose it to the browser. */
  token: string | null | undefined
  /** CENTRAL_BRIDGE_PRODUCT — slug reported by /health. */
  product: string
  handlers: HandlersSource
  /**
   * Shared store with an atomic lock. Required for writes (POST); without
   * it every write answers 500 `internal_error` instead of risking a
   * double execution.
   */
  idempotencyStore?: IdempotencyStore
  /** CENTRAL_BRIDGE_ALLOWED_IPS (array or comma-separated). Empty = any IP. */
  allowedIps?: string[] | string | null
  /**
   * Resolves the caller IP when `allowedIps` is set: `cloudflareIp`,
   * `vercelIp` or `nodeSocketIp`. Without it, a non-empty allowlist rejects
   * every request (fail closed).
   */
  getClientIp?: ClientIpResolver
  /**
   * Path + raw query exactly as the Central signed it. Defaults to
   * `url.pathname + url.search` of the incoming request. Override when a
   * rewrite/proxy changes the URL before it reaches this handler.
   */
  getSignedPath?: (request: Request) => string
  /** Defaults to `/central-api/v1`. Include any app base path (e.g. `/app/central-api/v1`). */
  basePath?: string
  /** Unix seconds clock. Defaults to Date.now(). */
  now?: () => number
  /** Reported by /health. Defaults to the package version. */
  version?: string
  maxSkewSeconds?: number
  idempotencyTtlHours?: number
  perPage?: number
  /** Larger bodies answer 422 before the HMAC is computed. Default 1 MiB. */
  maxBodyBytes?: number
  /** Defaults to console. Receives handler exceptions (never the token). */
  logger?: BridgeLogger
}

/**
 * Returns the Bridge `Response`, or `null` when the path is not under
 * `basePath` (let the host app handle it).
 */
export type CentralBridgeHandler = (
  request: Request,
  context?: BridgeCallContext
) => Promise<Response | null>

type RouteName =
  | 'health'
  | 'paymentOwner'
  | 'invoiceRequest'
  | 'subscriptions'
  | 'searchUsers'
  | 'findUser'
  | 'metrics'
  | 'changePlan'
  | 'sendPasswordReset'
  | 'suspend'
  | 'unsuspend'
  | 'receiveInvoice'

interface RouteDefinition {
  name: RouteName
  method: 'GET' | 'POST'
  segments: string[]
}

/** Routes of the contract (§7), relative to the base path. */
const ROUTES: readonly RouteDefinition[] = (
  [
    ['health', 'GET', 'health'],
    ['paymentOwner', 'GET', 'payments/:provider/:paymentId/owner'],
    ['invoiceRequest', 'GET', 'payments/:provider/:paymentId/invoice-request'],
    ['subscriptions', 'GET', 'subscriptions'],
    ['searchUsers', 'GET', 'users'],
    ['findUser', 'GET', 'users/:ref'],
    ['metrics', 'GET', 'metrics'],
    ['changePlan', 'POST', 'users/:ref/plan'],
    ['sendPasswordReset', 'POST', 'users/:ref/password-reset'],
    ['suspend', 'POST', 'users/:ref/suspend'],
    ['unsuspend', 'POST', 'users/:ref/unsuspend'],
    ['receiveInvoice', 'POST', 'invoices'],
  ] as const
).map(([name, method, pattern]) => ({ name, method, segments: pattern.split('/') }))

/** Exact paths kept by the sanitizer, per route (§5). */
const SANITIZER_ALLOW: Partial<Record<RouteName, string[]>> = {
  invoiceRequest: ['taker.document'],
}

const LOCK_TTL_SECONDS = 300
const MAX_QUERY_LENGTH = 191
const MAX_IDEMPOTENCY_KEY_LENGTH = 128
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const REQUEST_ID_RE = /^[\w.:-]{1,128}$/

interface BridgeResult {
  status: number
  body: unknown
  headers?: Record<string, string>
}

interface Call {
  method: string
  /** Signed path without query. */
  path: string
  query: URLSearchParams
  rawBody: string
  params: Record<string, string>
}

class BodyTooLargeError extends Error {}

function result(status: number, body: unknown, headers?: Record<string, string>): BridgeResult {
  return { status, body, headers }
}

function errorResult(code: BridgeErrorCode, message?: string): BridgeResult {
  const error = new BridgeError(code, message)
  return result(error.status, error.toBody())
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '')
  return trimmed ? `/${trimmed}` : ''
}

function defaultSignedPath(request: Request): string {
  const url = new URL(request.url)
  return `${url.pathname}${url.search}`
}

function matchRoute(
  method: string,
  relative: string
): { route: RouteDefinition; params: Record<string, string> } | null {
  const parts = relative.replace(/^\/+|\/+$/g, '').split('/')
  for (const route of ROUTES) {
    if (route.method !== method || route.segments.length !== parts.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (const [index, segment] of route.segments.entries()) {
      const part = parts[index]
      if (segment.startsWith(':')) {
        if (!part) {
          matched = false
          break
        }
        try {
          params[segment.slice(1)] = decodeURIComponent(part)
        } catch {
          matched = false
          break
        }
      } else if (segment !== part) {
        matched = false
        break
      }
    }
    if (matched) return { route, params }
  }
  return null
}

/** Reads the body exactly once, as bytes, enforcing `max`. */
async function readBody(request: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > max) throw new BodyTooLargeError()
  if (!request.body) return new Uint8Array(0)

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new BodyTooLargeError()
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function parsePage(value: string | null): number {
  if (value === null || value === '') return 1
  if (!/^\d{1,9}$/.test(value) || Number(value) < 1) {
    throw new ValidationFailedError(
      'Dados inválidos: "page" deve ser um inteiro maior ou igual a 1.'
    )
  }
  return Number(value)
}

/**
 * Creates the Bridge request handler: signature, IP allowlist, idempotency,
 * dispatch to the product handlers, wire serialization and sanitization,
 * using only Web standards (Request/Response, crypto.subtle).
 */
export function createCentralBridge(options: CentralBridgeOptions): CentralBridgeHandler {
  const enabled = options.enabled === true
  const token = (options.token ?? '').trim()
  const product = (options.product ?? '').trim()
  const version = options.version ?? BRIDGE_VERSION
  const basePath = normalizeBasePath(options.basePath ?? DEFAULT_BASE_PATH)
  const allowedIps = parseIps(options.allowedIps)
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const maxSkewSeconds = options.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS
  const ttlSeconds = (options.idempotencyTtlHours ?? DEFAULT_IDEMPOTENCY_TTL_HOURS) * 3600
  const perPage = options.perPage ?? DEFAULT_PER_PAGE
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const logger: BridgeLogger = options.logger ?? console
  const store = options.idempotencyStore

  let handlersPromise: Promise<BridgeHandlers> | undefined
  function resolveHandlers(): Promise<BridgeHandlers> {
    if (!handlersPromise) {
      const source = options.handlers
      handlersPromise = (async () => {
        if (typeof source !== 'function') return source
        const loaded = await source()
        return 'default' in loaded && loaded.default ? loaded.default : (loaded as BridgeHandlers)
      })()
      // Allow a retry if a lazy import fails.
      handlersPromise.catch(() => (handlersPromise = undefined))
    }
    return handlersPromise
  }

  async function capabilities(): Promise<Capability[]> {
    const h = await resolveHandlers()
    const list: Capability[] = []
    if (h.paymentOwner) list.push('payment_owner')
    if (h.subscriptions) list.push('subscriptions')
    if (h.searchUsers) list.push('users_search')
    if (h.findUser) list.push('user_detail')
    if (h.changePlan) list.push('change_plan')
    if (h.sendPasswordReset) list.push('password_reset')
    if (h.suspend && h.unsuspend) list.push('suspend')
    if (h.metrics) list.push('metrics')
    if (h.invoiceRequest && h.receiveInvoice) list.push('invoices')
    return list
  }

  function internalError(error: unknown, route: string): BridgeResult {
    logger.error({ err: error, route }, 'Central Bridge: erro ao processar a requisição')
    return result(500, errorBody('internal_error'))
  }

  async function run(route: RouteName, call: Call, actor: string): Promise<unknown> {
    const h = await resolveHandlers()
    const { query, params } = call

    switch (route) {
      case 'health':
        return { version, product, capabilities: await capabilities() } satisfies HealthResponse

      case 'paymentOwner': {
        if (!h.paymentOwner) throw new BridgeError('capability_unsupported')
        return paymentOwnerToWire(await h.paymentOwner(params.provider, params.paymentId))
      }

      case 'invoiceRequest': {
        if (!h.invoiceRequest) throw new BridgeError('capability_unsupported')
        return invoiceRequestToWire(await h.invoiceRequest(params.provider, params.paymentId))
      }

      case 'subscriptions': {
        if (!h.subscriptions) throw new BridgeError('capability_unsupported')
        const rawStatus = query.get('status') ?? ''
        if (rawStatus && !(SUBSCRIPTION_STATUSES as readonly string[]).includes(rawStatus)) {
          throw new ValidationFailedError(
            `Dados inválidos: "status" deve ser um de ${SUBSCRIPTION_STATUSES.join(', ')}.`
          )
        }
        const status = (rawStatus || null) as SubscriptionStatus | null
        const page = parsePage(query.get('page'))
        return pageToWire(
          await h.subscriptions(status, page, perPage),
          page,
          perPage,
          subscriptionToWire
        )
      }

      case 'searchUsers': {
        if (!h.searchUsers) throw new BridgeError('capability_unsupported')
        const q = query.get('q') ?? ''
        if (q.length > MAX_QUERY_LENGTH) {
          throw new ValidationFailedError(
            `Dados inválidos: "q" aceita no máximo ${MAX_QUERY_LENGTH} caracteres.`
          )
        }
        const page = parsePage(query.get('page'))
        return pageToWire(await h.searchUsers(q, page, perPage), page, perPage, userSummaryToWire)
      }

      case 'findUser': {
        if (!h.findUser) throw new BridgeError('capability_unsupported')
        const user = await h.findUser(params.ref)
        if (!user) throw new UserNotFoundError()
        return userDetailToWire(user)
      }

      case 'metrics': {
        if (!h.metrics) throw new BridgeError('capability_unsupported')
        const from = query.get('from') ?? ''
        const to = query.get('to') ?? ''
        if (!isValidDate(from) || !isValidDate(to) || from > to) {
          throw new ValidationFailedError(
            'Dados inválidos: informe "from" e "to" no formato YYYY-MM-DD, com from <= to.'
          )
        }
        return metricsToWire(await h.metrics(from, to))
      }

      case 'changePlan': {
        if (!h.changePlan) throw new BridgeError('capability_unsupported')
        await h.changePlan(params.ref, parsePlanChange(call.rawBody), actor)
        return { ok: true }
      }

      case 'sendPasswordReset': {
        if (!h.sendPasswordReset) throw new BridgeError('capability_unsupported')
        await h.sendPasswordReset(params.ref, actor)
        return { ok: true, message: 'E-mail de redefinição enviado.' }
      }

      case 'suspend': {
        if (!h.suspend) throw new BridgeError('capability_unsupported')
        await h.suspend(params.ref, parseReason(call.rawBody), actor)
        return { ok: true }
      }

      case 'unsuspend': {
        if (!h.unsuspend) throw new BridgeError('capability_unsupported')
        await h.unsuspend(params.ref, parseReason(call.rawBody), actor)
        return { ok: true }
      }

      case 'receiveInvoice': {
        if (!h.receiveInvoice) throw new BridgeError('capability_unsupported')
        await h.receiveInvoice(parseInvoiceDelivery(call.rawBody), actor)
        return { ok: true }
      }
    }
  }

  async function safeRun(route: RouteName, call: Call, actor: string): Promise<BridgeResult> {
    try {
      const body = await run(route, call, actor)
      return result(200, sanitize(body, SANITIZER_ALLOW[route] ?? []))
    } catch (error) {
      if (error instanceof BridgeError) return result(error.status, error.toBody())
      return internalError(error, route)
    }
  }

  function replay(record: IdempotencyRecord, fingerprint: string): BridgeResult {
    if (record.fingerprint !== fingerprint) return errorResult('idempotency_conflict')
    return result(record.status, record.body, { 'X-Idempotency-Replayed': 'true' })
  }

  async function executeWrite(
    route: RouteName,
    call: Call,
    request: Request
  ): Promise<BridgeResult> {
    const actor = (request.headers.get('x-central-actor') ?? '').trim()
    if (!actor || actor.length > 254 || !EMAIL_RE.test(actor)) {
      return errorResult('missing_actor')
    }

    const key = request.headers.get('x-idempotency-key') ?? ''
    if (key.length < 1 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      return errorResult(
        'validation_failed',
        'Dados inválidos: informe X-Idempotency-Key com 1 a 128 caracteres.'
      )
    }

    if (!store) {
      logger.error(
        { route },
        'Central Bridge: writes need a shared idempotencyStore (D1 or Upstash); refusing the write.'
      )
      return errorResult(
        'internal_error',
        'Bridge sem armazenamento de idempotência compartilhado: escrita recusada.'
      )
    }

    const fingerprint = await idempotencyFingerprint(call.method, call.path, call.rawBody)

    const existing = await store.get(key)
    if (existing) return replay(existing, fingerprint)

    const release = await store.lock(key, LOCK_TTL_SECONDS)
    if (!release) {
      const finished = await store.get(key)
      if (finished) return replay(finished, fingerprint)
      return errorResult('idempotency_conflict', IDEMPOTENCY_IN_PROGRESS_MESSAGE)
    }

    try {
      const response = await safeRun(route, call, actor)
      if (response.status < 500) {
        await store.set(
          key,
          { fingerprint, status: response.status, body: response.body },
          ttlSeconds
        )
      }
      return response
    } finally {
      await release()
    }
  }

  async function handle(
    request: Request,
    context: BridgeCallContext,
    signedPath: string,
    path: string
  ): Promise<BridgeResult> {
    // 1. disabled → 404
    if (!enabled) return errorResult('not_found')

    // 2. IP allowlist → 403 (fail closed without a resolver)
    if (allowedIps.length > 0) {
      const ip = options.getClientIp?.(request, context)
      if (!ip || !allowedIps.includes(normalizeIp(ip))) return errorResult('ip_not_allowed')
    }

    // 3. raw body, read once as bytes; JSON is parsed only after verification
    let bodyBytes: Uint8Array<ArrayBuffer>
    try {
      bodyBytes = await readBody(request, maxBodyBytes)
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return errorResult('validation_failed', 'Dados inválidos: corpo maior que o permitido.')
      }
      throw error
    }

    // 4. unauthorized → timestamp_skew → signature_invalid
    const verdict = await verifySignature({
      token,
      method: request.method,
      pathWithQuery: signedPath,
      rawBody: bodyBytes,
      timestamp: request.headers.get('x-central-timestamp'),
      signature: request.headers.get('x-central-signature'),
      now: now(),
      maxSkewSeconds,
    })
    if (verdict !== 'valid') return errorResult(verdict)

    const method = request.method.toUpperCase()
    const matched = matchRoute(method, path.slice(basePath.length))
    if (!matched) return errorResult('not_found')

    const queryIndex = signedPath.indexOf('?')
    const call: Call = {
      method,
      path,
      query: new URLSearchParams(queryIndex === -1 ? '' : signedPath.slice(queryIndex + 1)),
      rawBody: new TextDecoder().decode(bodyBytes),
      params: matched.params,
    }

    if (matched.route.method === 'POST') return executeWrite(matched.route.name, call, request)
    return safeRun(matched.route.name, call, '')
  }

  function toResponse(request: Request, outcome: BridgeResult): Response {
    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...outcome.headers,
    })
    const requestId = request.headers.get('x-central-request-id')
    if (requestId && REQUEST_ID_RE.test(requestId)) headers.set('X-Central-Request-Id', requestId)
    return new Response(JSON.stringify(outcome.body), { status: outcome.status, headers })
  }

  return async (request, context = {}) => {
    const signedPath = options.getSignedPath
      ? options.getSignedPath(request)
      : defaultSignedPath(request)
    const queryIndex = signedPath.indexOf('?')
    const path = queryIndex === -1 ? signedPath : signedPath.slice(0, queryIndex)
    if (path !== basePath && !path.startsWith(`${basePath}/`)) return null

    let outcome: BridgeResult
    try {
      outcome = await handle(request, context, signedPath, path)
    } catch (error) {
      outcome = internalError(error, path)
    }
    return toResponse(request, outcome)
  }
}
