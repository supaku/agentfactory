/**
 * SimHash implementation for near-duplicate detection.
 * Produces a 64-bit fingerprint where similar content produces similar hashes.
 */

/** Simple string hash for tokens (FNV-1a-like, 64-bit safe). */
function tokenHash(token: string): bigint {
  let hash = 0xcbf29ce484222325n
  for (let i = 0; i < token.length; i++) {
    hash ^= BigInt(token.charCodeAt(i))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash
}

export class SimHash {
  private bits: number

  constructor(bits = 64) {
    this.bits = bits
  }

  /** Compute a SimHash fingerprint for the given text. */
  compute(text: string): bigint {
    const tokens = this.tokenize(text)
    if (tokens.length === 0) return 0n

    // Weight vector: one entry per bit
    const weights = new Float64Array(this.bits)

    for (const token of tokens) {
      const hash = tokenHash(token)
      for (let i = 0; i < this.bits; i++) {
        if ((hash >> BigInt(i)) & 1n) {
          weights[i] += 1
        } else {
          weights[i] -= 1
        }
      }
    }

    // Convert weight vector to fingerprint
    let fingerprint = 0n
    for (let i = 0; i < this.bits; i++) {
      if (weights[i] > 0) {
        fingerprint |= 1n << BigInt(i)
      }
    }
    return fingerprint
  }

  /** Compute Hamming distance between two fingerprints. */
  hammingDistance(a: bigint, b: bigint): number {
    let xor = a ^ b
    let count = 0
    while (xor > 0n) {
      count += Number(xor & 1n)
      xor >>= 1n
    }
    return count
  }

  /** Check if two fingerprints are near-duplicates within threshold. */
  isNearDuplicate(a: bigint, b: bigint, threshold = 3): boolean {
    return this.hammingDistance(a, b) <= threshold
  }

  private tokenize(text: string): string[] {
    // Split on whitespace and punctuation, lowercase, filter short tokens
    return text
      .toLowerCase()
      .split(/[\s\p{P}]+/u)
      .filter(t => t.length >= 2)
  }
}
