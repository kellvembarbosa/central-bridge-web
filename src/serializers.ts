import { ValidationFailedError } from './errors.ts'
import type {
  DateLike,
  InvoiceDelivery,
  InvoiceRequest,
  MetricsDay,
  PageResult,
  PaymentOwner,
  PlanChange,
  SubscriptionRecord,
  UserDetail,
  UserSummary,
} from './types.ts'

/**
 * Explicit camelCase ⇄ snake_case mapping of the contract shapes. Free-form
 * dictionaries (limits, usage, metrics) keep their keys untouched.
 */

export function toIsoOrNull(value: DateLike | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (typeof value.toISO === 'function') return value.toISO()
  return null
}

export function paymentOwnerToWire(owner: PaymentOwner) {
  return {
    owned: Boolean(owner.owned),
    user_ref: owner.userRef ?? null,
    kind: owner.kind ?? null,
    local_status: owner.localStatus ?? null,
  }
}

export function invoiceRequestToWire(request: InvoiceRequest) {
  return {
    requested: Boolean(request.requested),
    request_ref: request.requestRef ?? null,
    email: request.email ?? null,
    service_description: request.serviceDescription ?? null,
    taker: request.taker ? { document: request.taker.document, name: request.taker.name } : null,
  }
}

export function subscriptionToWire(record: SubscriptionRecord) {
  return {
    ref: record.ref,
    user_ref: record.userRef,
    provider: record.provider,
    provider_subscription_id: record.providerSubscriptionId ?? null,
    status: record.status,
    plan: record.plan ?? null,
    amount_cents: record.amountCents ?? null,
    currency: record.currency ?? null,
    interval: record.interval ?? null,
    current_period_end: toIsoOrNull(record.currentPeriodEnd),
  }
}

export function userSummaryToWire(user: UserSummary) {
  return {
    ref: user.ref,
    email: user.email,
    name: user.name ?? null,
    plan: user.plan ?? null,
    suspended: Boolean(user.suspended),
    created_at: toIsoOrNull(user.createdAt),
    last_seen_at: toIsoOrNull(user.lastSeenAt),
  }
}

export function userDetailToWire(user: UserDetail) {
  return {
    ...userSummaryToWire(user),
    limits: user.limits ?? {},
    usage: user.usage ?? {},
    subscriptions: (user.subscriptions ?? []).map(subscriptionToWire),
    recent_events: (user.recentEvents ?? []).map((event) => ({
      type: event.type,
      at: toIsoOrNull(event.at),
      description: event.description ?? null,
    })),
  }
}

export function pageToWire<T, W>(
  result: PageResult<T>,
  page: number,
  perPage: number,
  map: (item: T) => W
) {
  return {
    data: (result.data ?? []).map(map),
    page,
    per_page: perPage,
    has_more: Boolean(result.hasMore),
  }
}

export function metricsToWire(days: MetricsDay[]) {
  return {
    data: (days ?? []).map((day) => ({ date: day.date, metrics: day.metrics ?? {} })),
  }
}

/* ------------------------------------------------------------------------ */
/* Inbound parsing (snake_case body → camelCase)                              */
/* ------------------------------------------------------------------------ */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function parseJsonObject(rawBody: string): Record<string, unknown> {
  if (!rawBody) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    throw new ValidationFailedError('Dados inválidos: o corpo não é um JSON válido.')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationFailedError('Dados inválidos: o corpo deve ser um objeto JSON.')
  }
  return parsed as Record<string, unknown>
}

function requiredString(body: Record<string, unknown>, field: string, max: number): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationFailedError(`Dados inválidos: o campo "${field}" é obrigatório.`)
  }
  if (value.length > max) {
    throw new ValidationFailedError(
      `Dados inválidos: o campo "${field}" aceita no máximo ${max} caracteres.`
    )
  }
  return value
}

function requiredId(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return requiredString(body, field, 191)
}

function nullableString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field]
  if (value === undefined || value === null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') {
    throw new ValidationFailedError(`Dados inválidos: o campo "${field}" deve ser texto.`)
  }
  return value
}

export function parsePlanChange(rawBody: string): PlanChange {
  const body = parseJsonObject(rawBody)
  const plan = requiredString(body, 'plan', 64)
  const reason = requiredString(body, 'reason', 500)
  const until = body.until ?? null
  if (until !== null && (typeof until !== 'string' || !isValidDate(until))) {
    throw new ValidationFailedError(
      'Dados inválidos: o campo "until" deve ser uma data YYYY-MM-DD ou null.'
    )
  }
  return { plan, until: until as string | null, reason }
}

export function parseReason(rawBody: string): string {
  return requiredString(parseJsonObject(rawBody), 'reason', 500)
}

export function parseInvoiceDelivery(rawBody: string): InvoiceDelivery {
  const body = parseJsonObject(rawBody)
  const status = body.status
  if (status !== 'issued' && status !== 'canceled') {
    throw new ValidationFailedError(
      'Dados inválidos: o campo "status" deve ser "issued" ou "canceled".'
    )
  }
  const delivery: InvoiceDelivery = {
    invoiceId: requiredId(body, 'invoice_id'),
    requestRef: nullableString(body, 'request_ref'),
    provider: requiredString(body, 'provider', 191),
    paymentId: requiredId(body, 'payment_id'),
    status,
    number: nullableString(body, 'number'),
    accessKey: nullableString(body, 'access_key'),
    issuedAt: nullableString(body, 'issued_at'),
    pdfUrl: nullableString(body, 'pdf_url'),
    xmlUrl: nullableString(body, 'xml_url'),
    message: nullableString(body, 'message'),
  }
  if ('view_url' in body) delivery.viewUrl = nullableString(body, 'view_url')
  return delivery
}
