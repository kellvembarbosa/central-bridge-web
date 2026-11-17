import type { IdempotencyLockRelease, IdempotencyRecord, IdempotencyStore } from '../idempotency.ts'

export interface UpstashStoreOptions {
  /** UPSTASH_REDIS_REST_URL */
  url: string
  /** UPSTASH_REDIS_REST_TOKEN (server secret). */
  token: string
  prefix?: string
  /** Defaults to global fetch. */
  fetch?: typeof fetch
}

const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

/**
 * Shared idempotency store on Upstash Redis over its REST API (works on
 * Vercel, Workers and Node without a TCP client). The lock is `SET NX EX`,
 * released only by its owner (compare-and-delete script).
 */
export class UpstashIdempotencyStore implements IdempotencyStore {
  #url: string
  #token: string
  #prefix: string
  #fetch: typeof fetch

  constructor(options: UpstashStoreOptions) {
    if (!options.url || !options.token) {
      throw new Error('UpstashIdempotencyStore: url and token are required.')
    }
    this.#url = options.url.replace(/\/+$/, '')
    this.#token = options.token
    this.#prefix = options.prefix ?? 'central_bridge:idempotency:'
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    const raw = await this.#command(['GET', `${this.#prefix}${key}`])
    if (typeof raw !== 'string') return null
    try {
      return JSON.parse(raw) as IdempotencyRecord
    } catch {
      return null
    }
  }

  async set(key: string, record: IdempotencyRecord, ttlSeconds: number): Promise<void> {
    await this.#command([
      'SET',
      `${this.#prefix}${key}`,
      JSON.stringify(record),
      'EX',
      Math.max(1, Math.ceil(ttlSeconds)),
    ])
  }

  async lock(key: string, ttlSeconds: number): Promise<IdempotencyLockRelease | null> {
    const lockKey = `${this.#prefix}lock:${key}`
    const owner = crypto.randomUUID()
    const acquired = await this.#command([
      'SET',
      lockKey,
      owner,
      'NX',
      'EX',
      Math.max(1, Math.ceil(ttlSeconds)),
    ])
    if (acquired !== 'OK') return null
    return async () => {
      await this.#command(['EVAL', RELEASE_SCRIPT, 1, lockKey, owner])
    }
  }

  async #command(args: (string | number)[]): Promise<unknown> {
    const response = await this.#fetch(this.#url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.#token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    })
    const body = (await response.json().catch(() => null)) as {
      result?: unknown
      error?: string
    } | null
    if (!response.ok || !body || body.error) {
      throw new Error(`Upstash ${args[0]} failed (HTTP ${response.status}).`)
    }
    return body.result
  }
}
