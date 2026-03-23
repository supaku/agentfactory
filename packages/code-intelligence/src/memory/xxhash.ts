import xxhashWasm from 'xxhash-wasm'

let hasherPromise: ReturnType<typeof xxhashWasm> | undefined

function getHasher() {
  if (!hasherPromise) {
    hasherPromise = xxhashWasm()
  }
  return hasherPromise
}

/** Compute a 64-bit xxHash hex string from content. */
export async function xxhash64(content: string): Promise<string> {
  const hasher = await getHasher()
  return hasher.h64ToString(content)
}
