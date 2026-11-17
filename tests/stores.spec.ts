import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { D1IdempotencyStore, D1_IDEMPOTENCY_SCHEMA, type D1Like } from '../src/stores/d1.ts'
import { UpstashIdempotencyStore } from '../src/stores/upstash.ts'
import { MemoryIdempotencyStore, type IdempotencyStore } from '../src/idempotency.ts'
import { makeBridge, writeRequest } from './helpers.ts'

/** D1 binding shim over node:sqlite, so the real SQL runs. */
function fakeD1(): D1Like {
  const db = new DatabaseSync(':memory:')
  db.exec(D1_IDEMPOTENCY_SCHEMA)
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (db.prepare(sql).get(...(values as never[])) as T) ?? null,
    run: async () => ({
      meta: { changes: Number(db.prepare(sql).run(...(values as never[])).changes) },
    }),
  })
  return { prepare: (sql) => statement(sql) }
}

/** Upstash REST shim: SET [NX] EX, GET, EVAL compare-and-delete. */
function fakeUpstash() {
  const data = new Map<string, { value: string; expiresAt: number }>()
  let clock = 0
  const live = (key: string) => {
    const entry = data.get(key)
    if (entry && entry.expiresAt <= clock) data.delete(key)
    return data.get(key)
  }
  const fetch = (async (_url: string, init: RequestInit) => {
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer up-token')
    const [cmd, ...args] = JSON.parse(String(init.body)) as (string | number)[]
    let result: unknown = null
    if (cmd === 'GET') result = live(String(args[0]))?.value ?? null
    if (cmd === 'SET') {
      const [key, value, ...flags] = args.map(String)
      const nx = flags.includes('NX')
      const ttl = Number(flags[flags.indexOf('EX') + 1])
      if (!(nx && live(key))) {
        data.set(key, { value, expiresAt: clock + ttl * 1000 })
        result = 'OK'
      }
    }
    if (cmd === 'EVAL') {
      const [, , key, owner] = args.map(String)
      result = live(key)?.value === owner ? (data.delete(key), 1) : 0
    }
    return new Response(JSON.stringify({ result }), { status: 200 })
  }) as typeof globalThis.fetch
  return { fetch, advance: (ms: number) => (clock += ms), now: () => clock }
}

function storeContract(
  name: string,
  make: () => { store: IdempotencyStore; advance: (ms: number) => void }
) {
  describe(`${name} store contract`, () => {
    it('get/set round trip and expiry', async () => {
      const { store, advance } = make()
      assert.equal(await store.get('k'), null)
      await store.set('k', { fingerprint: 'f', status: 200, body: { ok: true } }, 60)
      assert.deepEqual(await store.get('k'), { fingerprint: 'f', status: 200, body: { ok: true } })
      advance(61_000)
      assert.equal(await store.get('k'), null)
    })

    it('lock is exclusive, released only by its owner, and expires', async () => {
      const { store, advance } = make()
      const release = await store.lock('k', 300)
      assert.ok(release)
      assert.equal(await store.lock('k', 300), null)
      await release()
      const second = await store.lock('k', 300)
      assert.ok(second)
      advance(301_000)
      const third = await store.lock('k', 300)
      assert.ok(third, 'expired lock can be taken over')
      await second() // stale owner must not release the new lock
      assert.equal(await store.lock('k', 300), null)
      await third()
    })

    it('concurrent lock attempts: exactly one wins', async () => {
      const { store } = make()
      const results = await Promise.all(Array.from({ length: 10 }, () => store.lock('race', 300)))
      assert.equal(results.filter(Boolean).length, 1)
    })

    it('drives bridge replay end to end', async () => {
      const { store } = make()
      let runs = 0
      const bridge = makeBridge({
        idempotencyStore: store,
        handlers: { suspend: async () => void runs++, unsuspend: async () => {} },
      })
      const first = await bridge.call(
        await writeRequest('/central-api/v1/users/u1/suspend', { reason: 'x' })
      )
      const second = await bridge.call(
        await writeRequest('/central-api/v1/users/u1/suspend', { reason: 'x' })
      )
      assert.equal(first?.status, 200)
      assert.equal(second?.headers.get('x-idempotency-replayed'), 'true')
      assert.equal(runs, 1)
    })
  })
}

storeContract('memory', () => {
  let clock = 0
  return { store: new MemoryIdempotencyStore({ now: () => clock }), advance: (ms) => (clock += ms) }
})

storeContract('D1', () => {
  let clock = 0
  return {
    store: new D1IdempotencyStore(fakeD1(), { now: () => clock }),
    advance: (ms) => (clock += ms),
  }
})

storeContract('Upstash', () => {
  const upstash = fakeUpstash()
  return {
    store: new UpstashIdempotencyStore({
      url: 'https://up.test/',
      token: 'up-token',
      fetch: upstash.fetch,
    }),
    advance: upstash.advance,
  }
})

describe('Upstash errors', () => {
  it('HTTP/command errors throw (the bridge answers 500, nothing stored)', async () => {
    const store = new UpstashIdempotencyStore({
      url: 'https://up.test',
      token: 'up-token',
      fetch: (async () =>
        new Response(JSON.stringify({ error: 'WRONGPASS' }), { status: 401 })) as typeof fetch,
    })
    await assert.rejects(store.get('k'), /Upstash GET failed \(HTTP 401\)/)
  })
})
