/**
 * Client IP resolvers for `allowedIps`. Pick the one matching where the app
 * runs: each trusts a header that THAT platform sets and overwrites, so it
 * cannot be spoofed there. Using one on another platform is unsafe.
 *
 * `x-forwarded-for` is never trusted by default: its first entry is
 * attacker-controlled on most hosts.
 */

export interface BridgeCallContext {
  /** Socket address supplied by the host framework (e.g. SvelteKit `getClientAddress()`). */
  clientIp?: string | null
}

export type ClientIpResolver = (
  request: Request,
  context: BridgeCallContext
) => string | null | undefined

/** Cloudflare Workers / Pages: `cf-connecting-ip`, set by the Cloudflare edge. */
export const cloudflareIp: ClientIpResolver = (request) => request.headers.get('cf-connecting-ip')

/** Vercel: `x-real-ip`, else the first entry of `x-vercel-forwarded-for` (both set by Vercel). */
export const vercelIp: ClientIpResolver = (request) =>
  request.headers.get('x-real-ip') ??
  request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ??
  null

/**
 * Node servers: the socket address the caller passes as `bridge(request, { clientIp })`.
 * Behind your own reverse proxy, pass the address that proxy reports, never a
 * raw `x-forwarded-for`.
 */
export const nodeSocketIp: ClientIpResolver = (_request, context) => context.clientIp

export function normalizeIp(ip: string): string {
  const value = ip.trim().toLowerCase()
  return value.startsWith('::ffff:') && value.includes('.') ? value.slice(7) : value
}

export function parseIps(value: string[] | string | null | undefined): string[] {
  const list = Array.isArray(value) ? value : (value ?? '').split(',')
  return list.map((ip) => normalizeIp(ip)).filter(Boolean)
}
