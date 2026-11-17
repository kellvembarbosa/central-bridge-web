import { existsSync, readFileSync } from 'node:fs'
import { createCentralBridge, type CentralBridgeOptions } from '../src/bridge.ts'
import { MemoryIdempotencyStore } from '../src/idempotency.ts'
import { sign } from '../src/signature.ts'
import type { BridgeCallContext } from '../src/ip.ts'

export const TOKEN = 'cbt_test_token_0123456789abcdef'
export const ACTOR = 'ops@central.test'
export const NOW = 1763200000
export const ORIGIN = 'https://product.test'

// Standalone repo: ./test-vectors. Monorepo: ../bridge-test-vectors (canonical).
export function readVectors<T>(file: string): T {
  const local = new URL(`../test-vectors/${file}`, import.meta.url)
  const url = existsSync(local)
    ? local
    : new URL(`../../bridge-test-vectors/${file}`, import.meta.url)
  return JSON.parse(readFileSync(url, 'utf8')) as T
}

type Signer = (
  token: string,
  method: string,
  pathWithQuery: string,
  timestamp: number,
  body: string
) => string | Promise<string>

/**
 * In the monorepo, requests are signed by the Central's own `signRequest`
 * (app/services/bridge_signature.ts), proving the round trip. Standalone,
 * the package signer is used.
 */
const centralSignature = new URL('../../../app/services/bridge_signature.ts', import.meta.url)
export const centralSignerAvailable = existsSync(centralSignature)
export const centralSign: Signer = centralSignerAvailable
  ? ((await import(centralSignature.href)) as { signRequest: Signer }).signRequest
  : sign

export interface SignedOptions {
  body?: string
  headers?: Record<string, string>
  timestamp?: number | string
  token?: string
  /** Path that gets signed (defaults to the request path). */
  signPath?: string
  signBody?: string
  signature?: string
  unsigned?: boolean
}

export async function signedRequest(
  method: string,
  pathWithQuery: string,
  options: SignedOptions = {}
): Promise<Request> {
  const timestamp = options.timestamp ?? NOW
  const body = options.body ?? ''
  const headers: Record<string, string> = { ...options.headers }
  if (!options.unsigned) {
    headers['X-Central-Timestamp'] = String(timestamp)
    headers['X-Central-Signature'] =
      options.signature ??
      (await centralSign(
        options.token ?? TOKEN,
        method,
        options.signPath ?? pathWithQuery,
        Number(timestamp),
        options.signBody ?? body
      ))
  }
  if (body) headers['Content-Type'] = 'application/json'
  return new Request(`${ORIGIN}${pathWithQuery}`, {
    method,
    headers,
    body: body || undefined,
  })
}

export async function writeRequest(
  path: string,
  body: unknown,
  key = 'key-1',
  headers: Record<string, string> = {}
): Promise<Request> {
  return signedRequest('POST', path, {
    body: JSON.stringify(body),
    headers: { 'X-Central-Actor': ACTOR, 'X-Idempotency-Key': key, ...headers },
  })
}

export function makeBridge(overrides: Partial<CentralBridgeOptions> = {}) {
  const errors: unknown[] = []
  const handle = createCentralBridge({
    enabled: true,
    token: TOKEN,
    product: 'demo',
    handlers: {},
    idempotencyStore: new MemoryIdempotencyStore(),
    now: () => NOW,
    logger: { error: (obj) => errors.push(obj) },
    ...overrides,
  })
  return {
    errors,
    handle,
    async call(request: Request, context?: BridgeCallContext) {
      const response = await handle(request, context)
      if (!response) return null
      const text = await response.text()
      return {
        status: response.status,
        headers: response.headers,
        body: text ? JSON.parse(text) : null,
      }
    },
  }
}
