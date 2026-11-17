// @ts-nocheck — recipe for a host app: its framework imports resolve there, not in this repo.
// SvelteKit: src/hooks.server.ts
//
// `$env/static/private` keeps the token server-only (never `$env/static/public`
// or a PUBLIC_ prefix). With `paths.base = '/app'` the Central signs
// `/app/central-api/v1/...`: set `basePath: '/app/central-api/v1'`.
// adapter-node: `nodeSocketIp` + `event.getClientAddress()` (configure the
// adapter's ADDRESS_HEADER only if a trusted proxy sets it).
// adapter-cloudflare / adapter-vercel: use `cloudflareIp` / `vercelIp`.
import type { Handle } from '@sveltejs/kit'
import {
  CENTRAL_BRIDGE_ALLOWED_IPS,
  CENTRAL_BRIDGE_ENABLED,
  CENTRAL_BRIDGE_PRODUCT,
  CENTRAL_BRIDGE_TOKEN,
  UPSTASH_REDIS_REST_TOKEN,
  UPSTASH_REDIS_REST_URL,
} from '$env/static/private'
import { createCentralBridge, nodeSocketIp, UpstashIdempotencyStore } from '@central/bridge-web'
import { handlers } from '$lib/server/central-handlers'

const bridge = createCentralBridge({
  enabled: CENTRAL_BRIDGE_ENABLED === 'true',
  token: CENTRAL_BRIDGE_TOKEN,
  product: CENTRAL_BRIDGE_PRODUCT,
  allowedIps: CENTRAL_BRIDGE_ALLOWED_IPS,
  getClientIp: nodeSocketIp,
  idempotencyStore: new UpstashIdempotencyStore({
    url: UPSTASH_REDIS_REST_URL,
    token: UPSTASH_REDIS_REST_TOKEN,
  }),
  handlers,
})

export const handle: Handle = async ({ event, resolve }) => {
  const response = await bridge(event.request, { clientIp: event.getClientAddress() })
  return response ?? resolve(event)
}
