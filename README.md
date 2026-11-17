# @central/bridge-web

The Central Bridge (contract v1) for runtimes built on Web standards:
Cloudflare Workers / Pages, Vercel (Node or Edge), Astro on
`@astrojs/cloudflare`, Next.js, TanStack Start, SvelteKit, Deno, Bun and
Node ≥ 22. It uses only `Request`/`Response`, `crypto.subtle`, `TextEncoder`
and `fetch` — zero runtime dependencies.

Same contract, vectors and handlers as `@central/bridge-adonis` and
`applu/central-bridge` (Laravel). Contract: `docs/central/bridge-contract.md`
in the Central repository.

```bash
npm install github:kellvembarbosa/central-bridge-web#v1.0.0
```

(Source of truth: `packages/central-bridge-web` in the Central repository;
the public repo above is an export of it.)

## Security first

> **The token is a server secret.** `CENTRAL_BRIDGE_TOKEN` signs every
> admin call to your product. Never give it a client-exposed prefix —
> `PUBLIC_` (Astro/SvelteKit), `VITE_` (Vite/TanStack), `NEXT_PUBLIC_`
> (Next.js) — or it ends up in the browser bundle. Set it with
> `wrangler secret put CENTRAL_BRIDGE_TOKEN` (Cloudflare) or as an
> encrypted/Sensitive environment variable (Vercel). Never log it.

- **Signature**: HMAC-SHA256 verified with `crypto.subtle.verify`
  (constant-time). The received signature must be exactly 64 hex chars,
  otherwise `signature_invalid`. Check order (contract §2): disabled 404 →
  IP 403 → missing token/signature/bad timestamp 401 `unauthorized` → clock
  401 `timestamp_skew` → HMAC 401 `signature_invalid`.
- **Raw body**: read once, as bytes (default limit 1 MiB → 422), hashed as
  received; JSON is parsed only after the signature is valid. Pass the
  bridge the request **before** anything reads its body.
- **Exact path**: the HMAC covers the path + raw query the Central sent.
  Rewrites, proxies, `trailingSlash` redirects or base-path stripping
  (Vercel `rewrites`, Next.js `basePath`, SvelteKit `paths.base`) must not
  change it before the bridge sees it. If they do, pass
  `getSignedPath(request)` returning the original path + query, and set
  `basePath` to the full prefix the Central calls (e.g. `/app/central-api/v1`).
- **IP allowlist**: `x-forwarded-for` is never trusted by default (its
  first entry is attacker-controlled on most hosts). Use the resolver that
  matches the platform. With `allowedIps` set and no `getClientIp`, every
  request is rejected (fail closed).
- **Writes need a shared idempotency store.** Serverless runs many
  isolates; without a shared store with an atomic lock a retry could run
  twice. Without `idempotencyStore`, every POST answers 500 instead of
  silently using memory.
- **Sanitizer**: every 200 response drops keys whose name contains
  `password, senha, hash, token, secret, segredo, document, documento, cpf,
cnpj, remember, recovery` (only `taker.document` on invoice-request is
  kept). Handler exceptions answer 500 without details.

## Usage

```ts
import { createCentralBridge, cloudflareIp, D1IdempotencyStore } from '@central/bridge-web'

const bridge = createCentralBridge({
  enabled: env.CENTRAL_BRIDGE_ENABLED === 'true',
  token: env.CENTRAL_BRIDGE_TOKEN,
  product: env.CENTRAL_BRIDGE_PRODUCT,
  allowedIps: env.CENTRAL_BRIDGE_ALLOWED_IPS, // comma-separated; empty = any IP
  getClientIp: cloudflareIp,
  idempotencyStore: new D1IdempotencyStore(env.DB),
  handlers, // BridgeHandlers: implement only what the product supports
})

// Response for /central-api/v1/*, null for anything else (fall through).
const response = await bridge(request)
```

| Option             | Default                     |                                                        |
| ------------------ | --------------------------- | ------------------------------------------------------ |
| `enabled`          | —                           | `false` → every Bridge path answers 404                |
| `token`, `product` | —                           | `CENTRAL_BRIDGE_TOKEN`, `CENTRAL_BRIDGE_PRODUCT`       |
| `handlers`         | —                           | object or lazy `() => import(...)`                     |
| `idempotencyStore` | none                        | required for POST routes                               |
| `allowedIps`       | any                         | array or comma-separated string                        |
| `getClientIp`      | none                        | `cloudflareIp`, `vercelIp`, `nodeSocketIp` or your own |
| `getSignedPath`    | `url.pathname + url.search` | original path + query when rewritten                   |
| `basePath`         | `/central-api/v1`           |                                                        |
| `now`              | `Date.now()/1000`           | unix seconds                                           |
| `maxBodyBytes`     | 1 MiB                       |                                                        |
| `logger`           | `console`                   | receives handler exceptions                            |

Handlers have the same names and signatures as `@central/bridge-adonis`:
`paymentOwner`, `subscriptions`, `searchUsers`, `findUser`, `changePlan`,
`sendPasswordReset`, `suspend` + `unsuspend`, `metrics`, `invoiceRequest` +
`receiveInvoice`. Throw `UserNotFoundError` / `BridgeError` for contract
errors.

### Client IP resolvers

| Resolver       | Trusts                                           | Use on                                                               |
| -------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| `cloudflareIp` | `cf-connecting-ip`                               | Cloudflare Workers / Pages                                           |
| `vercelIp`     | `x-real-ip`, else first `x-vercel-forwarded-for` | Vercel                                                               |
| `nodeSocketIp` | `bridge(request, { clientIp })` from the caller  | plain Node (SvelteKit `event.getClientAddress()`, h3 `getRequestIP`) |

Each resolver is only safe on its platform, where the edge sets/overwrites
that header. Using `cloudflareIp` on a host that does not strip
`cf-connecting-ip` lets anyone spoof it.

### Idempotency stores

| Store                                     | Atomic lock                         | Use on                     |
| ----------------------------------------- | ----------------------------------- | -------------------------- |
| `D1IdempotencyStore(env.DB)`              | single upsert on a primary key      | Cloudflare (Astro + D1)    |
| `UpstashIdempotencyStore({ url, token })` | `SET NX EX` + owner-checked release | Vercel, anywhere with HTTP |
| `MemoryIdempotencyStore`                  | per isolate                         | **tests only**             |

D1 needs its tables once: run `D1_IDEMPOTENCY_SCHEMA` (exported string) in a
D1 migration.

> **Do not use Workers KV for idempotency.** KV is eventually consistent
> and has no compare-and-set: two isolates can both "acquire" the lock and
> run the same write twice.

Implement `IdempotencyStore` (`get`, `set`, atomic `lock`) for any other
backend.

## Framework recipes

Thin adapters in [`examples/`](./examples):

- [`cloudflare-worker.ts`](./examples/cloudflare-worker.ts) — Worker `fetch`, D1
- [`astro-cloudflare-middleware.ts`](./examples/astro-cloudflare-middleware.ts) — Astro `src/middleware.ts` on `@astrojs/cloudflare`
- [`nextjs-route.ts`](./examples/nextjs-route.ts) — `app/central-api/v1/[...path]/route.ts` on Vercel, Upstash
- [`tanstack-start-route.ts`](./examples/tanstack-start-route.ts) — server route `central-api/v1/$`
- [`sveltekit-hooks.server.ts`](./examples/sveltekit-hooks.server.ts) — `handle` hook

## Invoicing client (product → Central)

```ts
import { CentralClient } from '@central/bridge-web'

const central = new CentralClient({
  baseUrl: env.CENTRAL_URL,
  token: env.CENTRAL_BRIDGE_TOKEN,
  product: env.CENTRAL_BRIDGE_PRODUCT,
})
await central.issueInvoice(
  { taker: { document, name }, amountCents: 1990, description: 'Plano Pro' },
  `invoice:${paymentId}` // idempotency key
)
const pdf = await central.invoicePdf(id) // Uint8Array
```

Errors are `CentralApiError` (`code`, `status`; status 0 for transport errors).

## Development

```bash
npm run typecheck   # src without Node types (proves Web-only) + tests
npm test            # node --test: vectors, check order, IP, idempotency, stores, client
npm run test:workerd  # optional: needs esbuild + miniflare@4 installed
```

In the Central monorepo the tests sign requests with the Central's own
`signRequest` (`app/services/bridge_signature.ts`), so a passing run proves
the round trip.

MIT
