import { ValidationFailedError } from './errors.ts'

/**
 * Central-owned checkout (contract §10): the Central sells the product's
 * plans with its own gateway keys and tells the product when a payment
 * settles (`POST payment-events`). camelCase here; snake_case on the wire.
 */

export type PlanInterval = 'day' | 'week' | 'month' | 'year' | 'lifetime'

export interface Plan {
  slug: string
  name: string
  description: string | null
  /** How long one payment grants access (`lifetime` = forever). */
  interval: PlanInterval
  intervalCount: number
  /** The gateway charges again every period. */
  recurring: boolean
  amountCents: number
  /** Struck-through price, when there is one. */
  originalAmountCents: number | null
  currency: string
  badge: string | null
  features: string[]
  sortOrder: number
}

export type PaymentStatus = 'pending' | 'paid' | 'expired' | 'refunded' | 'failed'
export type PaymentMethod = 'pix' | 'card' | 'boleto' | 'other'

export interface PaymentPlan {
  slug: string
  name: string
  interval: PlanInterval
  intervalCount: number
  recurring: boolean
}

export interface PaymentRecord {
  /** Central payment id (uuid). Grant access idempotently by this id. */
  id: string
  status: PaymentStatus
  plan: PaymentPlan
  amountCents: number
  refundedCents: number
  currency: string
  method: PaymentMethod
  productUserRef: string
  customer: { name: string; email: string }
  /** Only while pending. */
  pix: { copyPaste: string; qrCodeImageUrl: string | null; expiresAt: string | null } | null
  /** Hosted payment page (card/boleto/Pix), only while pending. */
  checkoutUrl: string | null
  tracking: Record<string, string>
  /**
   * Until when this payment (and its renewals) grants access; null = lifetime
   * or not paid yet. The Central computes it: the product never does date math.
   */
  accessUntil: string | null
  createdAt: string
  paidAt: string | null
  refundedAt: string | null
  expiresAt: string | null
}

export const PAYMENT_EVENT_TYPES = [
  'payment.paid',
  'payment.refunded',
  'payment.expired',
  'subscription.renewed',
  'subscription.ended',
] as const

export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number]

/**
 * What the Central sends to `POST payment-events`. Must be handled
 * idempotently by `id` (it may arrive more than once):
 *
 * - `payment.paid`: set the access of `payment.productUserRef` to
 *   `payment.plan.slug` until `payment.accessUntil` (null = forever), once
 *   per `payment.id`.
 * - `payment.refunded`: full refund or chargeback, revoke.
 * - `payment.expired`: the pending charge expired unpaid.
 * - `subscription.renewed`: same as `payment.paid`, access now runs until the
 *   new `payment.accessUntil`.
 * - `subscription.ended`: the gateway will not charge again; access still
 *   runs until `payment.accessUntil`.
 *
 * `subscription` is sent for every paid plan that has a period (recurring or
 * one-off prepaid) and is null only for lifetime plans and never-paid
 * charges. `subscription.currentPeriodEnd` equals `payment.accessUntil`.
 */
export interface PaymentEvent {
  id: string
  type: PaymentEventType
  occurredAt: string
  payment: PaymentRecord
  subscription: { status: string; currentPeriodEnd: string | null } | null
}

export interface CreatePaymentInput {
  /** Plan slug (from listPlans). The price comes from the Central. */
  plan: string
  customer: { name: string; email: string; document?: string | null }
  /** The buyer's id in the product (`user_ref`). */
  productUserRef: string
  /** null/omitted = gateway default (or the buyer picks on the hosted page). */
  method?: 'pix' | 'card' | 'boleto' | null
  /** utm_* and similar, kept with the payment. */
  tracking?: Record<string, string> | null
}

// --------------------------------------------------------------------------
// Wire parsing (defensive: the event body comes over the network)
// --------------------------------------------------------------------------

type Obj = Record<string, unknown>

function invalid(field: string): never {
  throw new ValidationFailedError(`Dados inválidos: o campo "${field}" é inválido.`)
}

function obj(value: unknown, field: string): Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field)
  return value as Obj
}

function str(o: Obj, key: string, path: string): string {
  const value = o[key]
  if (typeof value !== 'string' || value === '') invalid(path + key)
  return value
}

function strOrNull(o: Obj, key: string, path: string): string | null {
  const value = o[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') invalid(path + key)
  return value
}

function int(o: Obj, key: string, path: string): number {
  const value = o[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) invalid(path + key)
  return value
}

function intOrNull(o: Obj, key: string, path: string): number | null {
  const value = o[key]
  if (value === undefined || value === null) return null
  return int(o, key, path)
}

function bool(o: Obj, key: string, path: string): boolean {
  const value = o[key]
  if (typeof value !== 'boolean') invalid(path + key)
  return value
}

function stringMap(value: unknown, path: string): Record<string, string> {
  if (value === undefined || value === null) return {}
  const o = obj(value, path)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(o)) {
    if (typeof v !== 'string') invalid(`${path}.${k}`)
    out[k] = v
  }
  return out
}

const INTERVALS: readonly string[] = ['day', 'week', 'month', 'year', 'lifetime']

function interval(o: Obj, path: string): PlanInterval {
  const value = o.interval
  if (typeof value !== 'string' || !INTERVALS.includes(value)) invalid(path + 'interval')
  return value as PlanInterval
}

export function parsePlan(wire: unknown): Plan {
  const o = obj(wire, 'plan')
  return {
    slug: str(o, 'slug', 'plan.'),
    name: str(o, 'name', 'plan.'),
    description: strOrNull(o, 'description', 'plan.'),
    interval: interval(o, 'plan.'),
    intervalCount: int(o, 'interval_count', 'plan.'),
    recurring: bool(o, 'recurring', 'plan.'),
    amountCents: int(o, 'amount_cents', 'plan.'),
    originalAmountCents: intOrNull(o, 'original_amount_cents', 'plan.'),
    currency: str(o, 'currency', 'plan.'),
    badge: strOrNull(o, 'badge', 'plan.'),
    features: Array.isArray(o.features)
      ? o.features.map((f, i) => (typeof f === 'string' ? f : invalid(`plan.features.${i}`)))
      : [],
    sortOrder: intOrNull(o, 'sort_order', 'plan.') ?? 0,
  }
}

const STATUSES: readonly string[] = ['pending', 'paid', 'expired', 'refunded', 'failed']

export function parsePaymentRecord(wire: unknown): PaymentRecord {
  const o = obj(wire, 'payment')
  const p = 'payment.'
  const status = str(o, 'status', p)
  if (!STATUSES.includes(status)) invalid(p + 'status')
  const plan = obj(o.plan, p + 'plan')
  const customer = obj(o.customer, p + 'customer')
  const pix = o.pix === null || o.pix === undefined ? null : obj(o.pix, p + 'pix')
  return {
    id: str(o, 'id', p),
    status: status as PaymentStatus,
    plan: {
      slug: str(plan, 'slug', p + 'plan.'),
      name: str(plan, 'name', p + 'plan.'),
      interval: interval(plan, p + 'plan.'),
      intervalCount: int(plan, 'interval_count', p + 'plan.'),
      recurring: bool(plan, 'recurring', p + 'plan.'),
    },
    amountCents: int(o, 'amount_cents', p),
    refundedCents: intOrNull(o, 'refunded_cents', p) ?? 0,
    currency: str(o, 'currency', p),
    method: (strOrNull(o, 'method', p) ?? 'other') as PaymentMethod,
    productUserRef: str(o, 'product_user_ref', p),
    customer: {
      name: str(customer, 'name', p + 'customer.'),
      email: str(customer, 'email', p + 'customer.'),
    },
    pix: pix
      ? {
          copyPaste: str(pix, 'copy_paste', p + 'pix.'),
          qrCodeImageUrl: strOrNull(pix, 'qr_code_image_url', p + 'pix.'),
          expiresAt: strOrNull(pix, 'expires_at', p + 'pix.'),
        }
      : null,
    checkoutUrl: strOrNull(o, 'checkout_url', p),
    tracking: stringMap(o.tracking, p + 'tracking'),
    accessUntil: strOrNull(o, 'access_until', p),
    createdAt: str(o, 'created_at', p),
    paidAt: strOrNull(o, 'paid_at', p),
    refundedAt: strOrNull(o, 'refunded_at', p),
    expiresAt: strOrNull(o, 'expires_at', p),
  }
}

/** Parses the `POST payment-events` body. Throws ValidationFailedError (422). */
export function parsePaymentEvent(body: Record<string, unknown>): PaymentEvent {
  const type = str(body, 'type', '')
  if (!(PAYMENT_EVENT_TYPES as readonly string[]).includes(type)) invalid('type')
  const sub =
    body.subscription === null || body.subscription === undefined
      ? null
      : obj(body.subscription, 'subscription')
  return {
    id: str(body, 'id', ''),
    type: type as PaymentEventType,
    occurredAt: str(body, 'occurred_at', ''),
    payment: parsePaymentRecord(body.payment),
    subscription: sub
      ? {
          status: str(sub, 'status', 'subscription.'),
          currentPeriodEnd: strOrNull(sub, 'current_period_end', 'subscription.'),
        }
      : null,
  }
}

export function createPaymentToWire(input: CreatePaymentInput) {
  return {
    plan: input.plan,
    customer: {
      name: input.customer.name,
      email: input.customer.email,
      ...(input.customer.document ? { document: input.customer.document } : {}),
    },
    product_user_ref: input.productUserRef,
    ...(input.method !== undefined ? { method: input.method } : {}),
    ...(input.tracking ? { tracking: input.tracking } : {}),
  }
}
