// @ts-nocheck — recipe for a host app: its framework imports resolve there, not in this repo.
// Next.js (App Router) on Vercel: app/central-api/v1/[...path]/route.ts
//
// Node.js or Edge runtime both work. Store: Upstash Redis (Vercel Marketplace).
// Env: Vercel "Sensitive"/encrypted env vars. Never prefix with NEXT_PUBLIC_.
// Do not add `rewrites`/`basePath`/`trailingSlash` that change /central-api/v1/* —
// the HMAC covers the exact path + query the Central sent.
import { createCentralBridge, vercelIp, UpstashIdempotencyStore } from '@central/bridge-web'
import { handlers } from '@/lib/central-handlers'

export const dynamic = 'force-dynamic'

const bridge = createCentralBridge({
  enabled: process.env.CENTRAL_BRIDGE_ENABLED === 'true',
  token: process.env.CENTRAL_BRIDGE_TOKEN,
  product: process.env.CENTRAL_BRIDGE_PRODUCT ?? '',
  allowedIps: process.env.CENTRAL_BRIDGE_ALLOWED_IPS,
  getClientIp: vercelIp,
  idempotencyStore: new UpstashIdempotencyStore({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  }),
  handlers,
})

async function handle(request: Request): Promise<Response> {
  return (await bridge(request)) ?? new Response(null, { status: 404 })
}

export { handle as GET, handle as POST }
