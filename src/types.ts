/**
 * Data shapes of the Bridge contract (§7). camelCase in TypeScript; the
 * Bridge converts them to snake_case on the wire.
 */

/** ISO-8601 string, a Date, or anything with `toISO()` (Luxon DateTime). */
export type DateLike = string | Date | { toISO(): string | null }

export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'expired',
  'paused',
] as const

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

export type MaybePromise<T> = T | Promise<T>

/** What a paginated handler returns; the Bridge adds `page` and `per_page`. */
export interface PageResult<T> {
  data: T[]
  hasMore: boolean
}

export interface PaymentOwner {
  owned: boolean
  userRef: string | null
  kind: 'subscription' | 'order' | null
  localStatus: string | null
}

export interface InvoiceTaker {
  document: string
  name: string
}

export interface InvoiceRequest {
  requested: boolean
  requestRef: string | null
  email: string | null
  serviceDescription: string | null
  taker: InvoiceTaker | null
}

export interface SubscriptionRecord {
  ref: string
  userRef: string
  provider: string
  providerSubscriptionId: string | null
  status: SubscriptionStatus
  plan: string | null
  amountCents: number | null
  currency: string | null
  interval: string | null
  currentPeriodEnd: DateLike | null
}

export interface UserSummary {
  ref: string
  email: string
  name: string | null
  plan: string | null
  suspended: boolean
  createdAt: DateLike | null
  lastSeenAt: DateLike | null
}

export interface UserEvent {
  type: string
  at: DateLike
  description: string | null
}

export interface UserDetail extends UserSummary {
  limits: Record<string, number | string | null>
  usage: Record<string, number>
  subscriptions: SubscriptionRecord[]
  recentEvents: UserEvent[]
}

export interface PlanChange {
  plan: string
  /** YYYY-MM-DD or null (no end date). */
  until: string | null
  reason: string
}

export interface MetricsDay {
  /** YYYY-MM-DD */
  date: string
  metrics: Record<string, number>
}

export interface InvoiceDelivery {
  invoiceId: string
  requestRef: string | null
  provider: string
  paymentId: string
  status: 'issued' | 'canceled'
  number: string | null
  accessKey: string | null
  issuedAt: string | null
  pdfUrl: string | null
  xmlUrl: string | null
  message: string | null
  viewUrl?: string | null
}

/**
 * Handlers the product implements. Every one is optional: a missing handler
 * answers 501 `capability_unsupported`. `actor` is the e-mail of who asked
 * in the Central (X-Central-Actor).
 *
 * Throw `UserNotFoundError` (or return `null` from `findUser`) for unknown
 * users, and `BridgeError` for any other contract error.
 */
export interface BridgeHandlers {
  paymentOwner?(provider: string, paymentId: string): MaybePromise<PaymentOwner>
  subscriptions?(
    status: SubscriptionStatus | null,
    page: number,
    perPage: number
  ): MaybePromise<PageResult<SubscriptionRecord>>
  searchUsers?(query: string, page: number, perPage: number): MaybePromise<PageResult<UserSummary>>
  findUser?(ref: string): MaybePromise<UserDetail | null>
  changePlan?(ref: string, change: PlanChange, actor: string): MaybePromise<void>
  sendPasswordReset?(ref: string, actor: string): MaybePromise<void>
  suspend?(ref: string, reason: string, actor: string): MaybePromise<void>
  unsuspend?(ref: string, reason: string, actor: string): MaybePromise<void>
  metrics?(from: string, to: string): MaybePromise<MetricsDay[]>
  invoiceRequest?(provider: string, paymentId: string): MaybePromise<InvoiceRequest>
  /** Must be idempotent by `delivery.invoiceId`. */
  receiveInvoice?(delivery: InvoiceDelivery, actor: string): MaybePromise<void>
}

/**
 * Handlers inline, or a lazy import (recommended in config files, so models
 * are only loaded once the app has booted):
 * `handlers: () => import('#services/central_bridge_handlers')`
 */
export type HandlersSource =
  | BridgeHandlers
  | (() => Promise<{ default: BridgeHandlers } | BridgeHandlers>)

export const CAPABILITIES = [
  'payment_owner',
  'subscriptions',
  'users_search',
  'user_detail',
  'change_plan',
  'password_reset',
  'suspend',
  'metrics',
  'invoices',
] as const

export type Capability = (typeof CAPABILITIES)[number]

export interface HealthResponse {
  version: string
  product: string
  capabilities: Capability[]
}

/** Minimal logger accepted by the Bridge (AdonisJS logger fits). */
export interface BridgeLogger {
  error(obj: unknown, msg?: string): void
}
