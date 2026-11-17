// @ts-nocheck — recipe for a host app: its framework imports resolve there, not in this repo.
// TanStack Start server route: src/routes/central-api/v1/$.ts
//
// Server-route API of TanStack Start 1.x (`server.handlers`); older releases
// used `createServerFileRoute`. Pick the IP resolver for where it is deployed:
// `vercelIp` on Vercel, `cloudflareIp` on Workers, or `nodeSocketIp` on a
// plain Node server (pass the socket address as `{ clientIp }`).
import { createFileRoute } from '@tanstack/react-router'
import { createCentralBridge, vercelIp, UpstashIdempotencyStore } from '@central/bridge-web'
import { handlers } from '~/server/central-handlers'

const bridge = createCentralBridge({
  enabled: process.env.CENTRAL_BRIDGE_ENABLED === 'true',
  token: process.env.CENTRAL_BRIDGE_TOKEN, // server-only; never VITE_*
  product: process.env.CENTRAL_BRIDGE_PRODUCT ?? '',
  allowedIps: process.env.CENTRAL_BRIDGE_ALLOWED_IPS,
  getClientIp: vercelIp,
  idempotencyStore: new UpstashIdempotencyStore({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  }),
  handlers,
})

async function handle({ request }: { request: Request }): Promise<Response> {
  return (await bridge(request)) ?? new Response(null, { status: 404 })
}

export const Route = createFileRoute('/central-api/v1/$')({
  server: { handlers: { GET: handle, POST: handle } },
})
