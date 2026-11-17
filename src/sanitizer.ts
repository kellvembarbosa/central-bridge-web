/**
 * Last barrier before a successful response leaves the product (§5).
 * Drops every key whose name contains a forbidden segment. Framework-free.
 */

export const FORBIDDEN_SEGMENTS: readonly string[] = [
  'password',
  'senha',
  'hash',
  'token',
  'secret',
  'segredo',
  'document',
  'documento',
  'cpf',
  'cnpj',
  'remember',
  'recovery',
]

const forbidden = new Set(FORBIDDEN_SEGMENTS)

function snakeCase(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
}

export function keySegments(key: string): string[] {
  const original = key.toLowerCase().replace(/[-\s]/g, '_')
  return [...snakeCase(key).split('_'), ...original.split('_')].filter(Boolean)
}

export function isForbiddenKey(key: string): boolean {
  return keySegments(key).some((segment) => forbidden.has(segment))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * @param allow exact dot paths (list indexes ignored) that are kept anyway,
 *              e.g. `taker.document` on invoice-request.
 */
export function sanitize<T = unknown>(value: T, allow: readonly string[] = []): T {
  return walk(value, '', new Set(allow)) as T
}

function walk(value: unknown, path: string, allow: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, path, allow))
  }
  if (!isPlainObject(value)) {
    return value
  }
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key
    if (isForbiddenKey(key) && !allow.has(childPath)) continue
    result[key] = walk(child, childPath, allow)
  }
  return result
}
