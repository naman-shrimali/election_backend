import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto"

/**
 * Derives a deterministic 32-byte key from any string secret
 * using SHA-256, so the secret doesn't need to be exactly 32 chars.
 */
function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest()
}

/**
 * Encrypts a JSON-serializable payload using AES-256-CBC.
 *
 * Output format (Base64-encoded):
 *   <16-byte IV (hex)>:<ciphertext (hex)>
 *
 * The random IV is regenerated on every call, so identical
 * payloads produce different ciphertext — preventing pattern analysis.
 */
export function encryptPayload(data: unknown, secret: string): string {
  const key = deriveKey(secret)
  const iv = randomBytes(16) // fresh random IV each call
  const cipher = createCipheriv("aes-256-cbc", key, iv)

  const json = JSON.stringify(data)
  const encrypted = Buffer.concat([cipher.update(json, "utf8"), cipher.final()])

  // Pack as "ivHex:ciphertextHex" then Base64-encode the whole thing
  const packed = `${iv.toString("hex")}:${encrypted.toString("hex")}`
  return Buffer.from(packed).toString("base64")
}

/**
 * Decrypts a payload produced by encryptPayload.
 * Returns the original parsed JSON value.
 */
export function decryptPayload<T = unknown>(token: string, secret: string): T {
  const key = deriveKey(secret)
  const packed = Buffer.from(token, "base64").toString("utf8")
  const [ivHex, ciphertextHex] = packed.split(":")

  if (!ivHex || !ciphertextHex) {
    throw new Error("Invalid encrypted token format")
  }

  const iv = Buffer.from(ivHex, "hex")
  const ciphertext = Buffer.from(ciphertextHex, "hex")

  const decipher = createDecipheriv("aes-256-cbc", key, iv)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])

  return JSON.parse(decrypted.toString("utf8")) as T
}
