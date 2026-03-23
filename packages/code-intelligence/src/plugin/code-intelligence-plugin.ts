import { z } from 'zod'
import { SymbolExtractor } from '../parser/symbol-extractor.js'
import { IncrementalIndexer } from '../indexing/incremental-indexer.js'
import { SearchEngine } from '../search/search-engine.js'
import { RepoMapGenerator } from '../repo-map/repo-map-generator.js'
import { DedupPipeline } from '../memory/dedup-pipeline.js'
import { InMemoryStore } from '../memory/memory-store.js'

export interface ToolPlugin {
  name: string
  description: string
  createTools(context: { env: Record<string, string>; cwd: string }): ToolDefinition[]
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: z.ZodType<any>
  execute: (args: any) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>
}

/** Create the code intelligence plugin. */
export const codeIntelligencePlugin: ToolPlugin = {
  name: 'af-code-intelligence',
  description: 'Code intelligence — symbol search, repo maps, code search, and memory deduplication',

  createTools(context) {
    const extractor = new SymbolExtractor()
    const indexer = new IncrementalIndexer(extractor, { indexDir: '.agentfactory/code-index' })
    const searchEngine = new SearchEngine()
    const repoMapGen = new RepoMapGenerator()
    const dedupStore = new InMemoryStore()
    const dedupPipeline = new DedupPipeline(dedupStore)

    const tools: ToolDefinition[] = [
      {
        name: 'af_code_search_symbols',
        description: 'Search for code symbols (functions, classes, types, etc.) by name or query',
        inputSchema: z.object({
          query: z.string().describe('Search query'),
          max_results: z.number().optional().describe('Maximum results (default 20)'),
          symbol_kinds: z.array(z.string()).optional().describe('Filter by symbol kinds'),
          file_pattern: z.string().optional().describe('Filter by file pattern (e.g. "*.ts")'),
        }),
        async execute(args) {
          try {
            const results = searchEngine.search({
              query: args.query,
              maxResults: args.max_results ?? 20,
              symbolKinds: args.symbol_kinds as any,
              filePattern: args.file_pattern,
            })
            return {
              content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
            }
          } catch (err) {
            return {
              content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            }
          }
        },
      },

      {
        name: 'af_code_get_repo_map',
        description: 'Get a PageRank-ranked repository map showing the most important files and their key symbols',
        inputSchema: z.object({
          max_files: z.number().optional().describe('Maximum files to include (default 50)'),
          file_patterns: z.array(z.string()).optional().describe('Filter file patterns'),
        }),
        async execute(args) {
          try {
            const stats = searchEngine.getStats()
            return {
              content: [{ type: 'text', text: JSON.stringify({ totalSymbols: stats.totalSymbols, message: 'Repo map available after indexing' }, null, 2) }],
            }
          } catch (err) {
            return {
              content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            }
          }
        },
      },

      {
        name: 'af_code_search_code',
        description: 'Search code using BM25 ranking with code-aware tokenization',
        inputSchema: z.object({
          query: z.string().describe('Code search query'),
          max_results: z.number().optional().describe('Maximum results (default 20)'),
          language: z.string().optional().describe('Filter by language'),
        }),
        async execute(args) {
          try {
            const results = searchEngine.search({
              query: args.query,
              maxResults: args.max_results ?? 20,
              language: args.language,
            })
            return {
              content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
            }
          } catch (err) {
            return {
              content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            }
          }
        },
      },

      {
        name: 'af_code_check_duplicate',
        description: 'Check if content is a duplicate using xxHash64 exact match and SimHash near-duplicate detection',
        inputSchema: z.object({
          content: z.string().describe('Content to check for duplicates'),
        }),
        async execute(args) {
          try {
            const result = await dedupPipeline.check(args.content)
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            }
          } catch (err) {
            return {
              content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            }
          }
        },
      },
    ]

    return tools
  },
}
