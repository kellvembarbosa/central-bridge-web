// @ts-nocheck — recipe for a host app: its framework imports resolve there, not in this repo.
// Astro on @astrojs/cloudflare (output: 'server'): src/middleware.ts
//
// The middleware runs before Astro routing, so the Bridge needs no page/endpoint.
// Env comes from the Cloudflare runtime: `context.locals.runtime.env` (Astro 5).
// On Astro 6 use `import { env } from 'cloudflare:workers'` instead.
// Secrets: `wrangler secret put CENTRAL_BRIDGE_TOKEN` — never `PUBLIC_*` (inlined in the client bundle).
import { defineMiddleware } from 'astro:middleware'
import {
  createCentralBridge,
  cloudflareIp,
  D1IdempotencyStore,
  type CentralBridgeHandler,
} from '@central/bridge-web'
import { handlers } from './lib/central-handlers'

let bridge: CentralBridgeHandler | undefined

export const onRequest = defineMiddleware(async (context, next) => {
  const env = context.locals.runtime.env
  bridge ??= createCentralBridge({
    enabled: env.CENTRAL_BRIDGE_ENABLED === 'true',
    token: env.CENTRAL_BRIDGE_TOKEN,
    product: env.CENTRAL_BRIDGE_PRODUCT,
    allowedIps: env.CENTRAL_BRIDGE_ALLOWED_IPS,
    getClientIp: cloudflareIp,
    idempotencyStore: new D1IdempotencyStore(env.DB),
    handlers,
  })

  // context.request is untouched here: body unread, URL as the Central signed it
  // (as long as `trailingSlash`/`base` do not redirect /central-api/v1/*).
  return (await bridge(context.request)) ?? next()
})
