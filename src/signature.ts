/**
 * HMAC request signature of the Bridge contract (§2), Web Crypto only.
 *
 * payload   = UPPER(method) \n pathWithQuery \n timestamp \n sha256_hex(rawBody)
 * signature = hex(hmac_sha256(token, payload))
 */

export const DEFAULT_MAX_SKEW_SECONDS = 300

export type SignatureVerdict = 'valid' | 'unauthorized' | 'timestamp_skew' | 'signature_invalid'

/** Raw body as text or as the exact bytes received. */
export type RawBody = string | Uint8Array<ArrayBuffer>

const encoder = new TextEncoder()
const SIGNATURE_RE = /^[0-9a-f]{64}$/i

function bytesOf(value: RawBody | null | undefined): Uint8Array<ArrayBuffer> {
  if (value === null || value === undefined) return new Uint8Array(0)
  return typeof value === 'string' ? encoder.encode(value) : value
}

function toHex(buffer: ArrayBuffer): string {
  let hex = ''
  for (const byte of new Uint8Array(buffer)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** Decodes a 32-byte HMAC-SHA256 hex digest; `null` when not exactly 64 hex chars. */
export function hexToSignatureBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!SIGNATURE_RE.test(value)) return null
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

export async function sha256Hex(value: RawBody): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', bytesOf(value)))
}

export async function signaturePayload(
  method: string,
  pathWithQuery: string,
  timestamp: string | number,
  rawBody: RawBody
): Promise<string> {
  return [method.toUpperCase(), pathWithQuery, String(timestamp), await sha256Hex(rawBody)].join(
    '\n'
  )
}

function hmacKey(token: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage]
  )
}

export async function sign(
  token: string,
  method: string,
  pathWithQuery: string,
  timestamp: string | number,
  rawBody: RawBody
): Promise<string> {
  const payload = await signaturePayload(method, pathWithQuery, timestamp, rawBody)
  const key = await hmacKey(token, 'sign')
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)))
}

export interface VerifySignatureInput {
  token: string | null | undefined
  method: string
  pathWithQuery: string
  rawBody: RawBody | null | undefined
  timestamp: string | null | undefined
  signature: string | null | undefined
  /** Current unix time in seconds. Defaults to Date.now(). */
  now?: number
  maxSkewSeconds?: number
}

/**
 * Applies the contract checks in order: missing token / signature / bad
 * timestamp (unauthorized) → clock (timestamp_skew) → HMAC (signature_invalid).
 *
 * The HMAC comparison is `crypto.subtle.verify`, which is constant-time.
 * A signature that is not 64 hex characters is `signature_invalid`.
 */
export async function verifySignature(input: VerifySignatureInput): Promise<SignatureVerdict> {
  const token = input.token ?? ''
  const signature = (input.signature ?? '').trim()
  const timestamp = (input.timestamp ?? '').trim()

  if (!token || !signature || !/^\d{1,12}$/.test(timestamp)) {
    return 'unauthorized'
  }

  const now = input.now ?? Math.floor(Date.now() / 1000)
  const maxSkew = input.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS
  if (Math.abs(now - Number(timestamp)) > maxSkew) {
    return 'timestamp_skew'
  }

  const received = hexToSignatureBytes(signature)
  if (!received) return 'signature_invalid'

  const payload = await signaturePayload(
    input.method,
    input.pathWithQuery,
    timestamp,
    bytesOf(input.rawBody)
  )
  const key = await hmacKey(token, 'verify')
  const ok = await crypto.subtle.verify('HMAC', key, received, encoder.encode(payload))
  return ok ? 'valid' : 'signature_invalid'
}
