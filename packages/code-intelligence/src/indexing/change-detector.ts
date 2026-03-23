import { MerkleTree } from './merkle-tree.js'

export interface ChangeSet {
  added: string[]
  modified: string[]
  deleted: string[]
}

/**
 * Diff two Merkle trees to identify changed files.
 */
export class ChangeDetector {
  /** Compare old and new trees, returning the set of changes. */
  detect(oldTree: MerkleTree, newTree: MerkleTree): ChangeSet {
    const oldFiles = oldTree.getFiles()
    const newFiles = newTree.getFiles()

    const added: string[] = []
    const modified: string[] = []
    const deleted: string[] = []

    // Find added and modified files
    for (const [path, newHash] of newFiles) {
      const oldHash = oldFiles.get(path)
      if (oldHash === undefined) {
        added.push(path)
      } else if (oldHash !== newHash) {
        modified.push(path)
      }
    }

    // Find deleted files
    for (const path of oldFiles.keys()) {
      if (!newFiles.has(path)) {
        deleted.push(path)
      }
    }

    return {
      added: added.sort(),
      modified: modified.sort(),
      deleted: deleted.sort(),
    }
  }

  /** Quick check if trees are identical (root hash comparison). */
  isIdentical(oldTree: MerkleTree, newTree: MerkleTree): boolean {
    return oldTree.getRootHash() === newTree.getRootHash()
  }
}
