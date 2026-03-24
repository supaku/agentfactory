import { z } from 'zod'
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { SymbolExtractor } from '../parser/symbol-extractor.js'
import { IncrementalIndexer } from '../indexing/incremental-indexer.js'
import { SearchEngine } from '../search/search-engine.js'
import { HybridSearchEngine } from '../search/hybrid-search.js'
import { RepoMapGenerator } from '../repo-map/repo-map-generator.js'
import { DedupPipeline } from '../memory/dedup-pipeline.js'
import { InMemoryStore } from '../memory/memory-store.js'

// ---------------------------------------------------------------------------
// Tool plugin types (structurally identical to @renseiai/agentfactory)
// Defined locally to avoid compile-time dependency on core.
// ---------------------------------------------------------------------------

/** A plugin that contributes agent tools from CLI functionality */
export interface ToolPlugin {
  name: string
  description: string
  createTools(context: ToolPluginContext): SdkMcpToolDefinition<any>[]
}

/** Context passed to plugins during tool creation */
export interface ToolPluginContext {
  env: Record<string, string>
  cwd: string
}

/** Create the code intelligence plugin. */
export const codeIntelligencePlugin: ToolPlugin = {
  name: 'af-code-intelligence',
  description: 'Code intelligence — symbol search, repo maps, code search, and memory deduplication',

  createTools(context) {
    const extractor = new SymbolExtractor()
    const indexer = new IncrementalIndexer(extractor, { indexDir: '.agentfactory/code-index' })
    const searchEngine = new SearchEngine()
    const hybridEngine = new HybridSearchEngine(searchEngine, null, null)
    const repoMapGen = new RepoMapGenerator()
    const dedupStore = new InMemoryStore()
    const dedupPipeline = new DedupPipeline(dedupStore)

    return [
      tool(
        'af_code_search_symbols',
        'Search for code symbols (functions, classes, types, etc.) by name or query',
        {
          query: z.string().describe('Search query'),
          max_results: z.number().optional().describe('Maximum results (default 20)'),
          symbol_kinds: z.array(z.string()).optional().describe('Filter by symbol kinds'),
          file_pattern: z.string().optional().describe('Filter by file pattern (e.g. "*.ts")'),
        },
        async (args) => {
          try {
            const results = searchEngine.search({
              query: args.query,
              maxResults: args.max_results ?? 20,
              symbolKinds: args.symbol_kinds as any,
              filePattern: args.file_pattern,
            })
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
            }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            }
          }
        }
      ),

      tool(
        'af_code_get_repo_map',
        'Get a PageRank-ranked repository map showing the most important files and their key symbols',
        {
          max_files: z.number().optional().describe('Maximum files to include (default 50)'),
          file_patterns: z.array(z.string()).optional().describe('Filter file patterns'),
        },
        async (args) => {
          try {
            const stats = searchEngine.getStats()
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ totalSymbols: stats.totalSymbols, message: 'Repo map available after indexing' }, null, 2) }],
            }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            }
          }
        }
      ),

      tool(
        'af_code_search_code',
        'Search code using hybrid BM25 + semantic ranking with code-aware tokenization',
        {
          query: z.string().describe('Code search query'),
          max_results: z.number().optional().describe('Maximum results (default 20)'),
          language: z.string().optional().describe('Filter by language'),
        },
        async (args) => {
          try {
            const results = await hybridEngine.search({
              query: args.query,
              maxResults: args.max_results ?? 20,
              language: args.language,
            })
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
            }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            }
          }
        }
      ),

      tool(
        'af_code_check_duplicate',
        'Check if content is a duplicate using xxHash64 exact match and SimHash near-duplicate detection',
        {
          content: z.string().describe('Content to check for duplicates'),
        },
        async (args) => {
          try {
            const result = await dedupPipeline.check(args.content)
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            }
          }
        }
      ),
    ]
  },
}
