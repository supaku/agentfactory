import { GitHashProvider } from './git-hash-provider.js'

export interface MerkleNode {
  path: string
  hash: string
  isDirectory: boolean
  children: Map<string, MerkleNode>
}

/**
 * Merkle tree for incremental code indexing.
 * Builds a tree from file paths + content hashes, enabling efficient diff.
 */
export class MerkleTree {
  private root: MerkleNode
  private hashProvider: GitHashProvider

  constructor() {
    this.hashProvider = new GitHashProvider()
    this.root = this.createDirNode('')
  }

  /** Build tree from file path -> content map. */
  static fromFiles(files: Map<string, string>): MerkleTree {
    const tree = new MerkleTree()
    for (const [path, content] of files) {
      tree.addFile(path, content)
    }
    tree.computeHashes()
    return tree
  }

  /** Build tree from file path -> pre-computed hash map. */
  static fromHashes(fileHashes: Map<string, string>): MerkleTree {
    const tree = new MerkleTree()
    for (const [path, hash] of fileHashes) {
      tree.addFileWithHash(path, hash)
    }
    tree.computeHashes()
    return tree
  }

  addFile(path: string, content: string): void {
    const hash = this.hashProvider.hashContent(content)
    this.addFileWithHash(path, hash)
  }

  addFileWithHash(path: string, hash: string): void {
    const parts = path.split('/').filter(Boolean)
    let current = this.root

    // Create directory nodes
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      if (!current.children.has(part)) {
        const dirPath = parts.slice(0, i + 1).join('/')
        current.children.set(part, this.createDirNode(dirPath))
      }
      current = current.children.get(part)!
    }

    // Create file node
    const fileName = parts[parts.length - 1]
    current.children.set(fileName, {
      path,
      hash,
      isDirectory: false,
      children: new Map(),
    })
  }

  /** Recompute all directory hashes bottom-up. */
  computeHashes(): void {
    this.computeNodeHash(this.root)
  }

  /** Get the root hash of the tree. */
  getRootHash(): string {
    return this.root.hash
  }

  /** Get all file nodes in the tree. */
  getFiles(): Map<string, string> {
    const files = new Map<string, string>()
    this.collectFiles(this.root, files)
    return files
  }

  /** Get a specific node by path. */
  getNode(path: string): MerkleNode | undefined {
    if (path === '' || path === '/') return this.root
    const parts = path.split('/').filter(Boolean)
    let current = this.root
    for (const part of parts) {
      const child = current.children.get(part)
      if (!child) return undefined
      current = child
    }
    return current
  }

  private computeNodeHash(node: MerkleNode): string {
    if (!node.isDirectory) return node.hash

    const childHashes: string[] = []
    for (const [name, child] of [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const childHash = this.computeNodeHash(child)
      childHashes.push(`${name}:${childHash}`)
    }
    node.hash = this.hashProvider.hashDirectory(childHashes)
    return node.hash
  }

  private collectFiles(node: MerkleNode, files: Map<string, string>): void {
    if (!node.isDirectory) {
      files.set(node.path, node.hash)
      return
    }
    for (const child of node.children.values()) {
      this.collectFiles(child, files)
    }
  }

  private createDirNode(path: string): MerkleNode {
    return { path, hash: '', isDirectory: true, children: new Map() }
  }
}
