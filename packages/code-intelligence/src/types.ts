import { z } from 'zod'

// ── Symbol Kinds ──────────────────────────────────────────────────────

export const SymbolKindSchema = z.enum([
  'function',
  'class',
  'interface',
  'type',
  'variable',
  'method',
  'property',
  'import',
  'export',
  'enum',
  'struct',
  'trait',
  'impl',
  'macro',
  'decorator',
  'module',
])
export type SymbolKind = z.infer<typeof SymbolKindSchema>

// ── Code Symbol ───────────────────────────────────────────────────────

export const CodeSymbolSchema = z.object({
  name: z.string().min(1),
  kind: SymbolKindSchema,
  filePath: z.string().min(1),
  line: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative().optional(),
  signature: z.string().optional(),
  documentation: z.string().optional(),
  exported: z.boolean().default(false),
  parentName: z.string().optional(),
  language: z.string().optional(),
})
export type CodeSymbol = z.infer<typeof CodeSymbolSchema>

// ── File AST ──────────────────────────────────────────────────────────

export const FileASTSchema = z.object({
  filePath: z.string().min(1),
  language: z.string().min(1),
  symbols: z.array(CodeSymbolSchema),
  imports: z.array(z.string()),
  exports: z.array(z.string()),
  hash: z.string().optional(),
})
export type FileAST = z.infer<typeof FileASTSchema>

// ── File Index (Merkle tree node) ─────────────────────────────────────

export const FileIndexSchema = z.object({
  filePath: z.string().min(1),
  gitHash: z.string().min(1),
  symbols: z.array(CodeSymbolSchema),
  lastIndexed: z.number(),
})
export type FileIndex = z.infer<typeof FileIndexSchema>

// ── Search ────────────────────────────────────────────────────────────

export const SearchQuerySchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().positive().default(20),
  filePattern: z.string().optional(),
  symbolKinds: z.array(SymbolKindSchema).optional(),
  language: z.string().optional(),
})
export type SearchQuery = z.infer<typeof SearchQuerySchema>

export const SearchResultSchema = z.object({
  symbol: CodeSymbolSchema,
  score: z.number().nonnegative(),
  matchType: z.enum(['exact', 'fuzzy', 'bm25']),
})
export type SearchResult = z.infer<typeof SearchResultSchema>

// ── Memory / Dedup ────────────────────────────────────────────────────

export const MemoryEntrySchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  xxhash: z.string(),
  simhash: z.bigint(),
  createdAt: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>

export const DedupResultSchema = z.object({
  isDuplicate: z.boolean(),
  matchType: z.enum(['exact', 'near', 'none']),
  existingId: z.string().optional(),
  hammingDistance: z.number().int().nonnegative().optional(),
})
export type DedupResult = z.infer<typeof DedupResultSchema>

// ── Index Metadata ────────────────────────────────────────────────────

export const IndexMetadataSchema = z.object({
  version: z.number().int().positive(),
  rootHash: z.string(),
  totalFiles: z.number().int().nonnegative(),
  totalSymbols: z.number().int().nonnegative(),
  lastUpdated: z.number(),
  languages: z.array(z.string()),
})
export type IndexMetadata = z.infer<typeof IndexMetadataSchema>

// ── Repo Map ──────────────────────────────────────────────────────────

export const RepoMapEntrySchema = z.object({
  filePath: z.string().min(1),
  rank: z.number().nonnegative(),
  symbols: z.array(z.object({
    name: z.string(),
    kind: SymbolKindSchema,
    line: z.number().int().nonnegative(),
  })),
})
export type RepoMapEntry = z.infer<typeof RepoMapEntrySchema>
