import { createHash } from 'node:crypto'

/**
 * Compute git-compatible object hashes for files.
 * Git uses: sha1("blob <size>\0<content>")
 */
export class GitHashProvider {
  /** Compute git blob hash for content (matches `git hash-object`). */
  hashContent(content: string): string {
    const buffer = Buffer.from(content)
    const header = `blob ${buffer.length}\0`
    const hash = createHash('sha1')
    hash.update(header)
    hash.update(buffer)
    return hash.digest('hex')
  }

  /** Compute a hash for a directory node (sorted child hashes). */
  hashDirectory(childHashes: string[]): string {
    const sorted = [...childHashes].sort()
    const combined = sorted.join('\n')
    const hash = createHash('sha1')
    hash.update(`tree ${combined.length}\0`)
    hash.update(combined)
    return hash.digest('hex')
  }
}
