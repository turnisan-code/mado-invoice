// The connector's secrets, server side only (node:crypto): random tokens and their SHA-256, PKCE,
// the HMAC-signed authorization request and AES-256-GCM for the grants' Supabase tokens. Every key
// is derived from MCP_SECRET with HKDF under its own purpose, so one key never serves two uses.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

const KEY_INFO = {
  authRequest: 'mado-invoice/mcp/v1/auth-request',
  sessionTokens: 'mado-invoice/mcp/v1/session-tokens',
  requestState: 'mado-invoice/mcp/v1/request-state',
} as const
export type KeyPurpose = keyof typeof KEY_INFO

const HKDF_SALT = 'mado-invoice/mcp'
const MIN_SECRET_BYTES = 32
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/

export class McpSecretError extends Error {
  constructor() {
    super('MCP_SECRET is missing or shorter than 32 bytes (base64)')
    this.name = 'McpSecretError'
  }
}

export function readMcpSecret(value: string | undefined = process.env.MCP_SECRET): Buffer {
  const text = value?.trim() ?? ''
  const raw = BASE64.test(text) ? Buffer.from(text, 'base64') : Buffer.alloc(0)
  if (raw.length < MIN_SECRET_BYTES) throw new McpSecretError()
  return raw
}

export function deriveKey(purpose: KeyPurpose, secret: Buffer = readMcpSecret()): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, KEY_INFO[purpose], 32))
}

// ─── Tokens and hashes ───────────────────────────────────────────────────────

// 256 bits by default; the prefix tells the kinds apart in logs and on sight.
export function randomToken(prefix: string, bytes = 32): string {
  return prefix + randomBytes(bytes).toString('base64url')
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

// Constant time whatever the lengths: both sides are hashed first.
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a, 'utf8').digest(), createHash('sha256').update(b, 'utf8').digest())
}

// ─── PKCE (RFC 7636, S256 only) ──────────────────────────────────────────────

const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  return PKCE_VERIFIER.test(verifier) && safeEqual(pkceChallenge(verifier), challenge)
}

// ─── Signed, expiring payloads (the authorization request between authorize and consent) ──

type Signed<T> = { p: T; exp: number }

export function signPayload<T>(payload: T, ttlSeconds: number, key: Buffer = deriveKey('authRequest'), now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ p: payload, exp: Math.floor(now / 1000) + ttlSeconds } satisfies Signed<T>)).toString('base64url')
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`
}

// The payload, or null when the signature does not match or it has expired.
export function verifyPayload<T>(token: string, key: Buffer = deriveKey('authRequest'), now = Date.now()): T | null {
  const dot = token.indexOf('.')
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null
  const body = token.slice(0, dot)
  if (!safeEqual(token.slice(dot + 1), createHmac('sha256', key).update(body).digest('base64url'))) return null
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Signed<T>
    return typeof parsed.exp === 'number' && parsed.exp > Math.floor(now / 1000) ? parsed.p : null
  } catch {
    return null
  }
}

// ─── Encryption at rest (AES-256-GCM) ────────────────────────────────────────

const ENC_VERSION = 'v1'
const IV_BYTES = 12
const TAG_BYTES = 16

// `aad` binds the ciphertext to its row (the grant id): a value copied to another grant does not decrypt.
export function encryptSecret(plaintext: string, aad: string, key: Buffer = deriveKey('sessionTokens')): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `${ENC_VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`
}

// Throws when the key, the aad or a single byte is wrong.
export function decryptSecret(blob: string, aad: string, key: Buffer = deriveKey('sessionTokens')): string {
  const [version, data] = blob.split('.')
  if (version !== ENC_VERSION || !data) throw new Error('Unknown encrypted value')
  const raw = Buffer.from(data, 'base64url')
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('Encrypted value too short')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES })
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
}
