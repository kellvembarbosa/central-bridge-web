import { sha256Hex } from './signature.ts'

/**
 * Idempotency storage for Bridge writes (§3).
 *
 * Serverless/edge runtimes run many isolates at once, so writes need a
 * SHARED store with an atomic lock: `D1IdempotencyStore` (Cloudflare) or
 * `UpstashIdempotencyStore` (Vercel and anywhere with HTTP). Workers KV is
 * eventually consistent and must not be used for the lock.
 */

export interface IdempotencyRecord {
  fingerprint: string
  status: number
  body: unknown
}

/** Releases a lock acquired with `IdempotencyStore.lock`. */
export type IdempotencyLockRelease = () => Promise<void>

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>
  set(key: string, record: IdempotencyRecord, ttlSeconds: number): Promise<void>
  /**
   * Atomically tries to acquire an exclusive lock for `key`. Returns a
   * release function when acquired, or `null` when another request holds it.
   */
  lock(key: string, ttlSeconds: number): Promise<IdempotencyLockRelease | null>
}

/** sha256(METHOD \n path \n rawBody) */
export function idempotencyFingerprint(
  method: string,
  path: string,
  rawBody: string
): Promise<string> {
  return sha256Hex(`${method.toUpperCase()}\n${path}\n${rawBody ?? ''}`)
}

/**
 * Isolate-local store. TESTS ONLY: on Workers/Vercel every isolate has its
 * own memory, so a retry may land where the first attempt is unknown.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  #records = new Map<string, { record: IdempotencyRecord; expiresAt: number }>()
  #locks = new Map<string, number>()
  #now: () => number

  /** @param options.now milliseconds clock (defaults to Date.now). */
  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now())
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    const entry = this.#records.get(key)
    if (!entry) return null
    if (entry.expiresAt <= this.#now()) {
      this.#records.delete(key)
      return null
    }
    return structuredClone(entry.record)
  }

  async set(key: string, record: IdempotencyRecord, ttlSeconds: number): Promise<void> {
    this.#records.set(key, {
      record: structuredClone(record),
      expiresAt: this.#now() + ttlSeconds * 1000,
    })
  }

  async lock(key: string, ttlSeconds: number): Promise<IdempotencyLockRelease | null> {
    const now = this.#now()
    const heldUntil = this.#locks.get(key)
    if (heldUntil !== undefined && heldUntil > now) return null

    const expiresAt = now + ttlSeconds * 1000
    this.#locks.set(key, expiresAt)
    return async () => {
      if (this.#locks.get(key) === expiresAt) this.#locks.delete(key)
    }
  }
}
