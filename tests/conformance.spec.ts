import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FORBIDDEN_SEGMENTS, isForbiddenKey, sanitize } from '../src/sanitizer.ts'
import { sha256Hex, sign, signaturePayload, verifySignature } from '../src/signature.ts'
import { readVectors } from './helpers.ts'

const signatureVectors = readVectors<{
  token: string
  max_skew_seconds: number
  cases: Array<{
    name: string
    method: string
    path: string
    timestamp: number
    body: string
    now: number
    expect: string
    signature: string
  }>
}>('signature.json')

const sanitizerVectors = readVectors<{
  forbidden_segments: string[]
  cases: Array<{ name: string; input: unknown; allow: string[]; output: unknown }>
}>('sanitizer.json')

describe('signature vectors (bridge-test-vectors/signature.json)', () => {
  for (const vector of signatureVectors.cases) {
    it(`${vector.name} → ${vector.expect}`, async () => {
      const verdict = await verifySignature({
        token: signatureVectors.token,
        method: vector.method,
        pathWithQuery: vector.path,
        rawBody: vector.body,
        timestamp: String(vector.timestamp),
        signature: vector.signature,
        now: vector.now,
        maxSkewSeconds: signatureVectors.max_skew_seconds,
      })
      assert.equal(verdict, vector.expect)

      if (vector.expect === 'valid') {
        assert.equal(
          await sign(
            signatureVectors.token,
            vector.method,
            vector.path,
            vector.timestamp,
            vector.body
          ),
          vector.signature.toLowerCase()
        )
      }
    })
  }
})

describe('signature unit', () => {
  const base = { token: 't', method: 'GET', pathWithQuery: '/x', rawBody: '', now: 1000 }

  it('payload format and empty-body hash', async () => {
    assert.equal(
      await signaturePayload('post', '/a?b=1', 5, 'x'),
      `POST\n/a?b=1\n5\n${await sha256Hex('x')}`
    )
    assert.equal(
      await sha256Hex(''),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
  })

  it('bytes and text bodies hash the same', async () => {
    const text = '{"reason":"Fraude confirmada ção"}'
    assert.equal(await sha256Hex(text), await sha256Hex(new TextEncoder().encode(text)))
  })

  it('missing token, signature or bad timestamp → unauthorized', async () => {
    const sig = await sign('t', 'GET', '/x', 1000, '')
    const cases: Array<[Partial<typeof base> & Record<string, unknown>, string]> = [
      [{ token: '', timestamp: '1000', signature: sig }, 'unauthorized'],
      [{ timestamp: '1000', signature: undefined }, 'unauthorized'],
      [{ timestamp: undefined, signature: sig }, 'unauthorized'],
      [{ timestamp: '10a0', signature: sig }, 'unauthorized'],
      [{ timestamp: '1234567890123', signature: sig }, 'unauthorized'],
      [{ timestamp: '-1000', signature: sig }, 'unauthorized'],
      [{ timestamp: '1000', signature: sig }, 'valid'],
      [{ timestamp: '1000', signature: sig.toUpperCase() }, 'valid'],
    ]
    for (const [input, expected] of cases) {
      assert.equal(
        await verifySignature({ ...base, ...input } as never),
        expected,
        JSON.stringify(input)
      )
    }
  })

  it('non-hex or wrong-length signature → signature_invalid', async () => {
    const sig = await sign('t', 'GET', '/x', 1000, '')
    for (const signature of ['zz', sig.slice(0, 62), `${sig}00`, `${sig.slice(0, 62)}zz`]) {
      assert.equal(
        await verifySignature({ ...base, timestamp: '1000', signature }),
        'signature_invalid',
        signature
      )
    }
  })

  it('skew is checked before the HMAC', async () => {
    assert.equal(
      await verifySignature({ ...base, timestamp: '1301', signature: 'zz' }),
      'timestamp_skew'
    )
  })
})

describe('sanitizer vectors (bridge-test-vectors/sanitizer.json)', () => {
  it('forbidden segments match the shared list', () => {
    assert.deepEqual(
      [...FORBIDDEN_SEGMENTS].sort(),
      [...sanitizerVectors.forbidden_segments].sort()
    )
  })

  for (const vector of sanitizerVectors.cases) {
    it(vector.name, () => {
      assert.deepEqual(sanitize(vector.input, vector.allow), vector.output)
    })
  }

  it('segments: snake, camel, kebab and spaces', () => {
    for (const key of ['APIToken', 'user password', 'client_secret', 'twoFactorRecoveryCodes']) {
      assert.equal(isForbiddenKey(key), true, key)
    }
    for (const key of ['documents_issued', 'tokens_used', 'hashtag', 'email']) {
      assert.equal(isForbiddenKey(key), false, key)
    }
  })
})
