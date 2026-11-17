import type { IdempotencyLockRelease, IdempotencyRecord, IdempotencyStore } from '../idempotency.ts'

/** Subset of the Cloudflare D1 binding used by the store. */
export interface D1Like {
  prepare(query: string): D1StatementLike
}

export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<{ meta?: { changes?: number } }>
}

/**
 * Run once (e.g. in a D1 migration) before using `D1IdempotencyStore`.
 */
export const D1_IDEMPOTENCY_SCHEMA = `CREATE TABLE IF NOT EXISTS central_bridge_idempotency (
  key TEXT PRIMARY KEY,
  record TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS central_bridge_locks (
  key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);`

/**
 * Shared idempotency store on Cloudflare D1.
 *
 * The lock is a single upsert on a primary key: it inserts, or takes over a
 * lock whose TTL ran out, and reports `changes = 1` only to the winner.
 * SQLite serializes writes, so exactly one isolate acquires it.
 */
export class D1IdempotencyStore implements IdempotencyStore {
  #db: D1Like
  #now: () => number

  /** @param options.now milliseconds clock (defaults to Date.now). */
  constructor(db: D1Like, options: { now?: () => number } = {}) {
    this.#db = db
    this.#now = options.now ?? (() => Date.now())
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    const row = await this.#db
      .prepare('SELECT record FROM central_bridge_idempotency WHERE key = ? AND expires_at > ?')
      .bind(key, this.#now())
      .first<{ record: string }>()
    if (!row) return null
    try {
      return JSON.parse(row.record) as IdempotencyRecord
    } catch {
      return null
    }
  }

  async set(key: string, record: IdempotencyRecord, ttlSeconds: number): Promise<void> {
    const now = this.#now()
    await this.#db
      .prepare('DELETE FROM central_bridge_idempotency WHERE expires_at <= ?')
      .bind(now)
      .run()
    await this.#db
      .prepare(
        `INSERT INTO central_bridge_idempotency (key, record, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET record = excluded.record, expires_at = excluded.expires_at`
      )
      .bind(key, JSON.stringify(record), now + ttlSeconds * 1000)
      .run()
  }

  async lock(key: string, ttlSeconds: number): Promise<IdempotencyLockRelease | null> {
    const now = this.#now()
    const owner = crypto.randomUUID()
    const result = await this.#db
      .prepare(
        `INSERT INTO central_bridge_locks (key, owner, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
         WHERE central_bridge_locks.expires_at <= ?`
      )
      .bind(key, owner, now + ttlSeconds * 1000, now)
      .run()
    if ((result.meta?.changes ?? 0) !== 1) return null

    return async () => {
      await this.#db
        .prepare('DELETE FROM central_bridge_locks WHERE key = ? AND owner = ?')
        .bind(key, owner)
        .run()
    }
  }
}
