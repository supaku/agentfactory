/**
 * Template generator for create-agentfactory-app
 *
 * Returns a map of file paths → file contents.
 */

export interface TemplateOptions {
  projectName: string
  teamKey: string
  includeDashboard: boolean
  includeCli: boolean
  useRedis: boolean
}

export function getTemplates(opts: TemplateOptions): Record<string, string> {
  const files: Record<string, string> = {}

  // ── Root config files ──────────────────────────────────────────

  files['package.json'] = packageJson(opts)
  files['tsconfig.json'] = tsconfig()
  files['next.config.ts'] = nextConfig()
  files['.env.example'] = envExample(opts)
  files['.gitignore'] = gitignore()

  // ── Core app files ─────────────────────────────────────────────

  files['src/lib/config.ts'] = configTs()
  files['src/middleware.ts'] = middlewareTs()

  // ── Route re-exports ───────────────────────────────────────────

  files['src/app/webhook/route.ts'] = routeReexport('routes.webhook.POST', 'routes.webhook.GET')
  files['src/app/callback/route.ts'] = routeReexport(null, 'routes.oauth.callback.GET')

  // Worker routes
  files['src/app/api/workers/register/route.ts'] = routeReexport('routes.workers.register.POST')
  files['src/app/api/workers/route.ts'] = routeReexport(null, 'routes.workers.list.GET')
  files['src/app/api/workers/[id]/route.ts'] = routeReexport(null, 'routes.workers.detail.GET', 'routes.workers.detail.DELETE')
  files['src/app/api/workers/[id]/heartbeat/route.ts'] = routeReexport('routes.workers.heartbeat.POST')
  files['src/app/api/workers/[id]/poll/route.ts'] = routeReexport(null, 'routes.workers.poll.GET')

  // Session routes
  files['src/app/api/sessions/route.ts'] = routeReexport(null, 'routes.sessions.list.GET')
  files['src/app/api/sessions/[id]/route.ts'] = routeReexport(null, 'routes.sessions.detail.GET')
  files['src/app/api/sessions/[id]/claim/route.ts'] = routeReexport('routes.sessions.claim.POST')
  files['src/app/api/sessions/[id]/status/route.ts'] = routeReexport('routes.sessions.status.POST', 'routes.sessions.status.GET')
  files['src/app/api/sessions/[id]/lock-refresh/route.ts'] = routeReexport('routes.sessions.lockRefresh.POST')
  files['src/app/api/sessions/[id]/prompts/route.ts'] = routeReexport('routes.sessions.prompts.POST', 'routes.sessions.prompts.GET')
  files['src/app/api/sessions/[id]/transfer-ownership/route.ts'] = routeReexport('routes.sessions.transferOwnership.POST')
  files['src/app/api/sessions/[id]/activity/route.ts'] = routeReexport('routes.sessions.activity.POST')
  files['src/app/api/sessions/[id]/completion/route.ts'] = routeReexport('routes.sessions.completion.POST')
  files['src/app/api/sessions/[id]/external-urls/route.ts'] = routeReexport('routes.sessions.externalUrls.POST')
  files['src/app/api/sessions/[id]/progress/route.ts'] = routeReexport('routes.sessions.progress.POST')
  files['src/app/api/sessions/[id]/tool-error/route.ts'] = routeReexport('routes.sessions.toolError.POST')

  // Public routes
  files['src/app/api/public/stats/route.ts'] = routeReexport(null, 'routes.public.stats.GET')
  files['src/app/api/public/sessions/route.ts'] = routeReexport(null, 'routes.public.sessions.GET')
  files['src/app/api/public/sessions/[id]/route.ts'] = routeReexport(null, 'routes.public.sessionDetail.GET')

  // Cleanup route
  files['src/app/api/cleanup/route.ts'] = routeReexport('routes.cleanup.POST', 'routes.cleanup.GET')

  // ── Dashboard ──────────────────────────────────────────────────

  if (opts.includeDashboard) {
    files['src/app/layout.tsx'] = layoutTsx(opts)
    files['src/app/page.tsx'] = dashboardPageTsx()
    files['src/app/globals.css'] = globalsCss()
  } else {
    files['src/app/layout.tsx'] = layoutTsx(opts)
    files['src/app/page.tsx'] = minimalPageTsx()
    files['src/app/globals.css'] = globalsCss()
  }

  // ── CLI tools ──────────────────────────────────────────────────

  if (opts.includeCli) {
    files['cli/worker.ts'] = cliWorker()
    files['cli/orchestrator.ts'] = cliOrchestrator()
    files['cli/worker-fleet.ts'] = cliWorkerFleet()
    files['cli/cleanup.ts'] = cliCleanup()
  }

  // ── Agent definitions ──────────────────────────────────────────

  files['.claude/agents/developer.md'] = agentDefinitionDeveloper()

  return files
}

// ── Template helpers ───────────────────────────────────────────────

function routeReexport(post: string | null, get?: string, del?: string): string {
  const lines = [`import { routes } from '@/lib/config'`]
  if (post) lines.push(`export const POST = ${post}`)
  if (get) lines.push(`export const GET = ${get}`)
  if (del) lines.push(`export const DELETE = ${del}`)
  return lines.join('\n') + '\n'
}

// ── Individual templates ───────────────────────────────────────────

function packageJson(opts: TemplateOptions): string {
  const deps: Record<string, string> = {
    '@supaku/agentfactory': '^0.4.0',
    '@supaku/agentfactory-linear': '^0.4.0',
    '@supaku/agentfactory-nextjs': '^0.4.0',
    '@supaku/agentfactory-server': '^0.4.0',
    'next': '^15.3.0',
    'react': '^19.0.0',
    'react-dom': '^19.0.0',
  }

  const devDeps: Record<string, string> = {
    '@types/node': '^22',
    '@types/react': '^19',
    'typescript': '^5',
  }

  const scripts: Record<string, string> = {
    'dev': 'next dev',
    'build': 'next build',
    'start': 'next start',
    'typecheck': 'tsc --noEmit',
  }

  if (opts.includeCli) {
    deps['@supaku/agentfactory-cli'] = '^0.4.0'
    scripts['worker'] = 'tsx cli/worker.ts'
    scripts['orchestrator'] = 'tsx cli/orchestrator.ts'
    scripts['worker-fleet'] = 'tsx cli/worker-fleet.ts'
    scripts['cleanup'] = 'tsx cli/cleanup.ts'
    devDeps['tsx'] = '^4'
    devDeps['dotenv'] = '^16'
  }

  const pkg = {
    name: opts.projectName,
    version: '0.1.0',
    private: true,
    scripts,
    dependencies: deps,
    devDependencies: devDeps,
  }

  return JSON.stringify(pkg, null, 2) + '\n'
}

function tsconfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2017',
      lib: ['dom', 'dom.iterable', 'esnext'],
      allowJs: true,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: 'esnext',
      moduleResolution: 'bundler',
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: 'react-jsx',
      incremental: true,
      baseUrl: '.',
      paths: { '@/*': ['./src/*'] },
      plugins: [{ name: 'next' }],
    },
    include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
    exclude: ['node_modules'],
  }, null, 2) + '\n'
}

function nextConfig(): string {
  return `import type { NextConfig } from 'next'

const nextConfig: NextConfig = {}

export default nextConfig
`
}

function envExample(opts: TemplateOptions): string {
  const lines = [
    '# Linear API Access',
    '# Create at: Settings > API > Personal API Keys',
    'LINEAR_ACCESS_TOKEN=lin_api_...',
    '',
    '# Linear Webhook Verification',
    '# Create at: Settings > API > Webhooks',
    'LINEAR_WEBHOOK_SECRET=',
    '',
    '# Linear OAuth App (optional — for multi-workspace)',
    '# LINEAR_CLIENT_ID=',
    '# LINEAR_CLIENT_SECRET=',
    '',
    '# App URL (for OAuth redirect)',
    `NEXT_PUBLIC_APP_URL=http://localhost:3000`,
    '',
  ]

  if (opts.useRedis) {
    lines.push(
      '# Redis (required for distributed workers)',
      '# Format: redis://[:password@]host[:port][/db]',
      'REDIS_URL=redis://localhost:6379',
      '',
    )
  }

  if (opts.includeCli) {
    lines.push(
      '# Worker Configuration',
      '# WORKER_API_URL=https://your-app.vercel.app',
      '# WORKER_API_KEY=',
      '',
    )
  }

  lines.push(
    '# Agent Provider (default: claude)',
    '# Options: claude, codex, amp',
    '# AGENT_PROVIDER=claude',
    '',
    '# Auto-trigger Configuration',
    '# ENABLE_AUTO_QA=false',
    '# ENABLE_AUTO_ACCEPTANCE=false',
  )

  return lines.join('\n') + '\n'
}

function gitignore(): string {
  return `node_modules/
.next/
dist/
.env.local
.env*.local
.worktrees/
.agent/
*.tsbuildinfo
`
}

function configTs(): string {
  return `/**
 * AgentFactory Configuration
 *
 * Central route wiring — connects your callbacks to the route factories.
 * Customize generatePrompt and other hooks to match your workflow.
 */

import { createAllRoutes, createDefaultLinearClientResolver } from '@supaku/agentfactory-nextjs'

export const routes = createAllRoutes({
  linearClient: createDefaultLinearClientResolver(),
  // Uncomment and customize as needed:
  // generatePrompt: (identifier, workType, mentionContext) => {
  //   return \`Work on issue \${identifier} (type: \${workType})\`
  // },
  // autoTrigger: {
  //   enableAutoQA: true,
  //   enableAutoAcceptance: false,
  //   autoQARequireAgentWorked: true,
  //   autoAcceptanceRequireAgentWorked: true,
  //   autoQAProjects: [],
  //   autoAcceptanceProjects: [],
  //   autoQAExcludeLabels: [],
  //   autoAcceptanceExcludeLabels: [],
  // },
})
`
}

function middlewareTs(): string {
  return `import { createAgentFactoryMiddleware } from '@supaku/agentfactory-nextjs'

const { middleware } = createAgentFactoryMiddleware()

export { middleware }

// Must be a static object literal for Next.js build analysis
export const config = {
  matcher: [
    '/api/:path*',
    '/webhook',
    '/dashboard',
    '/sessions/:path*',
    '/',
  ],
}
`
}

function layoutTsx(opts: TemplateOptions): string {
  return `import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '${opts.projectName} — AgentFactory',
  description: 'AI agent fleet management',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
`
}

function globalsCss(): string {
  return `@tailwind base;
@tailwind components;
@tailwind utilities;
`
}

function dashboardPageTsx(): string {
  return `export default function DashboardPage() {
  return (
    <main className="min-h-screen bg-gray-950 text-white p-8">
      <h1 className="text-3xl font-bold mb-2">AgentFactory</h1>
      <p className="text-gray-400 mb-8">Your AI agent fleet is running.</p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
          <h2 className="text-sm font-medium text-gray-400 mb-1">Status</h2>
          <p className="text-2xl font-bold text-green-400">Active</p>
        </div>
        <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
          <h2 className="text-sm font-medium text-gray-400 mb-1">Webhook</h2>
          <p className="text-sm text-gray-300 font-mono">/webhook</p>
        </div>
        <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
          <h2 className="text-sm font-medium text-gray-400 mb-1">Public API</h2>
          <p className="text-sm text-gray-300 font-mono">/api/public/stats</p>
        </div>
      </div>

      <div className="mt-8 text-sm text-gray-500">
        <p>Configure your Linear webhook to point to <code className="text-gray-400">/webhook</code></p>
        <p className="mt-1">View agent sessions at <code className="text-gray-400">/api/public/sessions</code></p>
      </div>
    </main>
  )
}
`
}

function minimalPageTsx(): string {
  return `export default function HomePage() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>AgentFactory</h1>
      <p>Webhook server is running. Configure your Linear webhook to point to <code>/webhook</code>.</p>
    </main>
  )
}
`
}

function cliWorker(): string {
  return `#!/usr/bin/env tsx
import path from 'path'
import { config } from 'dotenv'

// Load environment from .env.local
config({ path: path.resolve(import.meta.dirname, '..', '.env.local') })

import { runWorker } from '@supaku/agentfactory-cli/worker'

const apiUrl = process.env.WORKER_API_URL
const apiKey = process.env.WORKER_API_KEY

if (!apiUrl || !apiKey) {
  console.error('Missing WORKER_API_URL or WORKER_API_KEY in .env.local')
  process.exit(1)
}

runWorker({
  apiUrl,
  apiKey,
  capacity: 3,
}).catch((err) => {
  console.error('Worker failed:', err)
  process.exit(1)
})
`
}

function cliOrchestrator(): string {
  return `#!/usr/bin/env tsx
import path from 'path'
import { config } from 'dotenv'

// Load environment from .env.local
config({ path: path.resolve(import.meta.dirname, '..', '.env.local') })

import { runOrchestrator } from '@supaku/agentfactory-cli/orchestrator'

const project = process.argv.find((_, i, a) => a[i - 1] === '--project') ?? undefined
const single = process.argv.find((_, i, a) => a[i - 1] === '--single') ?? undefined
const dryRun = process.argv.includes('--dry-run')
const max = Number(process.argv.find((_, i, a) => a[i - 1] === '--max')) || 3

runOrchestrator({
  project,
  single,
  dryRun,
  max,
}).catch((err) => {
  console.error('Orchestrator failed:', err)
  process.exit(1)
})
`
}

function cliWorkerFleet(): string {
  return `#!/usr/bin/env tsx
import path from 'path'
import { config } from 'dotenv'

// Load environment from .env.local
config({ path: path.resolve(import.meta.dirname, '..', '.env.local') })

import { runWorkerFleet } from '@supaku/agentfactory-cli/worker-fleet'

const apiUrl = process.env.WORKER_API_URL
const apiKey = process.env.WORKER_API_KEY

if (!apiUrl || !apiKey) {
  console.error('Missing WORKER_API_URL or WORKER_API_KEY in .env.local')
  process.exit(1)
}

runWorkerFleet({
  apiUrl,
  apiKey,
}).catch((err) => {
  console.error('Worker fleet failed:', err)
  process.exit(1)
})
`
}

function cliCleanup(): string {
  return `#!/usr/bin/env tsx
import path from 'path'
import { config } from 'dotenv'

// Load environment from .env.local
config({ path: path.resolve(import.meta.dirname, '..', '.env.local') })

import { runCleanup } from '@supaku/agentfactory-cli/cleanup'

const dryRun = process.argv.includes('--dry-run')

runCleanup({ dryRun }).catch((err) => {
  console.error('Cleanup failed:', err)
  process.exit(1)
})
`
}

function agentDefinitionDeveloper(): string {
  return `# Developer Agent

You are a coding agent working on issues from the project backlog.

## Workflow

1. Read the issue requirements carefully
2. Explore the existing codebase to understand patterns
3. Implement the feature or fix
4. Write tests if the project has a test framework
5. Run \`pnpm test\` and \`pnpm typecheck\` to verify
6. Create a PR with a clear description

## Guidelines

- Follow existing code patterns and conventions
- Keep changes focused on the issue requirements
- Don't refactor unrelated code
- Write clear commit messages
`
}
