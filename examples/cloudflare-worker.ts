// @ts-nocheck — recipe for a host app: its framework imports resolve there, not in this repo.
// Cloudflare Worker (module syntax) with D1 as the idempotency store.
//
//   wrangler d1 execute <db> --remote --command "$(node -e "import('@central/bridge-web').then(m=>console.log(m.D1_IDEMPOTENCY_SCHEMA))")"
//   wrangler secret put CENTRAL_BRIDGE_TOKEN
//
// wrangler.toml: [vars] CENTRAL_BRIDGE_ENABLED = "true", CENTRAL_BRIDGE_PRODUCT = "my-product",
// CENTRAL_BRIDGE_ALLOWED_IPS = "<Central IPs>", and a [[d1_databases]] binding named DB.
import {
  createCentralBridge,
  cloudflareIp,
  D1IdempotencyStore,
  type CentralBridgeHandler,
  type D1Like,
} from '@central/bridge-web'
import { handlers } from './central-handlers' // your BridgeHandlers object

interface Env {
  DB: D1Like
  CENTRAL_BRIDGE_ENABLED: string
  CENTRAL_BRIDGE_TOKEN: string
  CENTRAL_BRIDGE_PRODUCT: string
  CENTRAL_BRIDGE_ALLOWED_IPS?: string
}

let bridge: CentralBridgeHandler | undefined

function getBridge(env: Env): CentralBridgeHandler {
  bridge ??= createCentralBridge({
    enabled: env.CENTRAL_BRIDGE_ENABLED === 'true',
    token: env.CENTRAL_BRIDGE_TOKEN,
    product: env.CENTRAL_BRIDGE_PRODUCT,
    allowedIps: env.CENTRAL_BRIDGE_ALLOWED_IPS,
    getClientIp: cloudflareIp,
    idempotencyStore: new D1IdempotencyStore(env.DB),
    handlers,
  })
  return bridge
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await getBridge(env)(request)
    if (response) return response
    return new Response('Not found', { status: 404 }) // the rest of your app
  },
}
