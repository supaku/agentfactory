// Core types and schemas
export {
  SymbolKindSchema,
  CodeSymbolSchema,
  FileASTSchema,
  FileIndexSchema,
  SearchQuerySchema,
  SearchResultSchema,
  MemoryEntrySchema,
  DedupResultSchema,
  IndexMetadataSchema,
  RepoMapEntrySchema,
} from './types.js'
export type {
  SymbolKind,
  CodeSymbol,
  FileAST,
  FileIndex,
  SearchQuery,
  SearchResult,
  MemoryEntry,
  DedupResult,
  IndexMetadata,
  RepoMapEntry,
} from './types.js'

// Parser
export { SymbolExtractor } from './parser/symbol-extractor.js'
export type { LanguageExtractor } from './parser/symbol-extractor.js'
export { TypeScriptExtractor } from './parser/typescript-extractor.js'
export { PythonExtractor } from './parser/python-extractor.js'
export { GoExtractor } from './parser/go-extractor.js'
export { RustExtractor } from './parser/rust-extractor.js'

// Indexing
export { MerkleTree, type MerkleNode } from './indexing/merkle-tree.js'
export { GitHashProvider } from './indexing/git-hash-provider.js'
export { ChangeDetector } from './indexing/change-detector.js'
export { IncrementalIndexer } from './indexing/incremental-indexer.js'

// Search
export { CodeTokenizer } from './search/tokenizer.js'
export { InvertedIndex } from './search/inverted-index.js'
export { BM25 } from './search/bm25.js'
export { SearchEngine } from './search/search-engine.js'

// Repo Map
export { DependencyGraph } from './repo-map/dependency-graph.js'
export { PageRank } from './repo-map/pagerank.js'
export { RepoMapGenerator } from './repo-map/repo-map-generator.js'

// Memory
export { xxhash64 } from './memory/xxhash.js'
export { SimHash } from './memory/simhash.js'
export { DedupPipeline } from './memory/dedup-pipeline.js'
export type { MemoryStore } from './memory/memory-store.js'
export { InMemoryStore } from './memory/memory-store.js'

// Plugin
export { codeIntelligencePlugin } from './plugin/code-intelligence-plugin.js'
