import { readFile, readdir, stat } from 'node:fs/promises'
import { join, extname, relative } from 'node:path'

// ── Supported extensions (mirrors SymbolExtractor's EXTENSION_MAP) ──────────

const SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs',
])

const IGNORE_DIRS = new Set([
  'node_modules', 'dist', '.git', '.next', '.turbo',
  'build', 'coverage', '__pycache__', '.agentfactory',
  '.worktrees', 'vendor', 'target',
])

// ── Types ───────────────────────────────────────────────────────────────────

export interface CodeIntelligenceRunnerConfig {
  command: string
  args: Record<string, string | string[] | boolean>
  positionalArgs: string[]
  cwd: string
}

export interface CodeIntelligenceRunnerResult {
  output: unknown
}

// ── Arg parsing ─────────────────────────────────────────────────────────────

export function parseCodeArgs(argv: string[]): {
  command: string | undefined
  args: Record<string, string | string[] | boolean>
  positionalArgs: string[]
} {
  const args: Record<string, string | string[] | boolean> = {}
  const positionalArgs: string[] = []
  let command: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        args[key] = next
        i++
      } else {
        args[key] = true
      }
    } else if (!command) {
      command = arg
    } else {
      positionalArgs.push(arg)
    }
  }

  return { command, args, positionalArgs }
}

// ── File discovery ──────────────────────────────────────────────────────────

async function discoverSourceFiles(cwd: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && IGNORE_DIRS.has(entry.name)) continue
      if (IGNORE_DIRS.has(entry.name)) continue

      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name))) {
        // Skip files larger than 512KB (likely generated)
        try {
          const s = await stat(fullPath)
          if (s.size > 512 * 1024) continue
        } catch {
          continue
        }

        try {
          const content = await readFile(fullPath, 'utf-8')
          const relPath = relative(cwd, fullPath)
          files.set(relPath, content)
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  await walk(cwd)
  return files
}

// ── Index initialization ────────────────────────────────────────────────────

async function initializeIndex(cwd: string) {
  const {
    SymbolExtractor,
    IncrementalIndexer,
    SearchEngine,
    HybridSearchEngine,
    RepoMapGenerator,
    DedupPipeline,
    InMemoryStore,
  } = await import('@renseiai/agentfactory-code-intelligence')

  const extractor = new SymbolExtractor()
  const indexer = new IncrementalIndexer(extractor, { indexDir: '.agentfactory/code-index' })
  const searchEngine = new SearchEngine()
  const hybridEngine = new HybridSearchEngine(searchEngine, null, null)
  const repoMapGen = new RepoMapGenerator()
  const dedupStore = new InMemoryStore()
  const dedupPipeline = new DedupPipeline(dedupStore)

  // Try loading persisted index
  const loaded = await indexer.load(cwd)

  if (loaded) {
    const symbols = indexer.getAllSymbols()
    searchEngine.buildIndex(symbols)
  } else {
    // No persisted index — discover files and build fresh
    const files = await discoverSourceFiles(cwd)
    await indexer.index(files)
    await indexer.save(cwd)
    const symbols = indexer.getAllSymbols()
    searchEngine.buildIndex(symbols)
  }

  return { indexer, searchEngine, hybridEngine, repoMapGen, dedupPipeline, extractor }
}

// ── Command handlers ────────────────────────────────────────────────────────

async function searchSymbols(
  config: CodeIntelligenceRunnerConfig,
  engines: Awaited<ReturnType<typeof initializeIndex>>,
): Promise<unknown> {
  const query = config.positionalArgs[0]
  if (!query) throw new Error('Usage: af-code search-symbols <query> [--max-results N] [--kinds "function,class"] [--file-pattern "*.ts"]')

  const maxResults = config.args['max-results'] ? Number(config.args['max-results']) : 20
  const kinds = config.args['kinds']
    ? (typeof config.args['kinds'] === 'string' ? config.args['kinds'].split(',').map(s => s.trim()) : config.args['kinds'])
    : undefined
  const filePattern = typeof config.args['file-pattern'] === 'string' ? config.args['file-pattern'] : undefined

  const results = engines.searchEngine.search({
    query,
    maxResults,
    symbolKinds: kinds as any,
    filePattern,
  })

  return results
}

async function getRepoMap(
  config: CodeIntelligenceRunnerConfig,
  engines: Awaited<ReturnType<typeof initializeIndex>>,
): Promise<unknown> {
  const maxFiles = config.args['max-files'] ? Number(config.args['max-files']) : 50
  const rawPatterns = config.args['file-patterns']
  const filePatterns = typeof rawPatterns === 'string'
    ? rawPatterns.split(',').map(s => s.trim())
    : Array.isArray(rawPatterns) ? rawPatterns : undefined

  // Rebuild ASTs from the file index for PageRank computation
  const fileIndex = engines.indexer.getFileIndex()
  const asts = [...fileIndex.values()].map(fi => ({
    filePath: fi.filePath,
    language: fi.symbols[0]?.language ?? 'unknown',
    symbols: fi.symbols,
    imports: [] as string[],
    exports: fi.symbols.filter(s => s.exported).map(s => s.name),
  }))

  const entries = engines.repoMapGen.generate(asts, { maxFiles, filePatterns })
  const formatted = engines.repoMapGen.format(entries)

  return { entries, formatted }
}

async function searchCode(
  config: CodeIntelligenceRunnerConfig,
  engines: Awaited<ReturnType<typeof initializeIndex>>,
): Promise<unknown> {
  const query = config.positionalArgs[0]
  if (!query) throw new Error('Usage: af-code search-code <query> [--max-results N] [--language ts]')

  const maxResults = config.args['max-results'] ? Number(config.args['max-results']) : 20
  const language = typeof config.args['language'] === 'string' ? config.args['language'] : undefined

  const results = await engines.hybridEngine.search({
    query,
    maxResults,
    language,
  })

  return results
}

async function checkDuplicate(
  config: CodeIntelligenceRunnerConfig,
  engines: Awaited<ReturnType<typeof initializeIndex>>,
): Promise<unknown> {
  let content: string

  if (typeof config.args['content-file'] === 'string') {
    content = await readFile(config.args['content-file'], 'utf-8')
  } else if (typeof config.args['content'] === 'string') {
    content = config.args['content']
  } else {
    throw new Error('Usage: af-code check-duplicate --content "<code>" or --content-file /path/to/file')
  }

  const result = await engines.dedupPipeline.check(content)
  return result
}

// ── Main runner ─────────────────────────────────────────────────────────────

export async function runCodeIntelligence(
  config: CodeIntelligenceRunnerConfig,
): Promise<CodeIntelligenceRunnerResult> {
  const engines = await initializeIndex(config.cwd)

  switch (config.command) {
    case 'search-symbols':
      return { output: await searchSymbols(config, engines) }
    case 'get-repo-map':
      return { output: await getRepoMap(config, engines) }
    case 'search-code':
      return { output: await searchCode(config, engines) }
    case 'check-duplicate':
      return { output: await checkDuplicate(config, engines) }
    default:
      throw new Error(`Unknown command: ${config.command}. Available: search-symbols, get-repo-map, search-code, check-duplicate`)
  }
}
