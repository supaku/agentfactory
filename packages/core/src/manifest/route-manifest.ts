/**
 * Route Manifest — Single source of truth for all AgentFactory route and page files.
 *
 * Used by `af-sync-routes` to generate missing route files in consumer projects,
 * and by parity tests to verify create-app templates stay aligned.
 */

export type HttpMethod = 'GET' | 'POST' | 'DELETE'

export interface RouteEntry {
  /** Relative file path, e.g. "src/app/api/workers/register/route.ts" */
  path: string
  /** Map of HTTP method → routes accessor, e.g. { POST: 'routes.workers.register.POST' } */
  methods: Partial<Record<HttpMethod, string>>
}

export interface PageEntry {
  /** Relative file path, e.g. "src/app/pipeline/page.tsx" */
  path: string
  /** Dashboard component name, e.g. "PipelinePage" */
  component: string
  /** Default export function name, e.g. "Pipeline" */
  exportName: string
  /** Import alias if different from component, e.g. "DashboardPage as FleetPage" */
  importAlias?: string
  /** Dynamic route params, e.g. ["id"] for [id] segments */
  params?: string[]
  /** Map of param name → component prop name, e.g. { id: "sessionId" } */
  propMapping?: Record<string, string>
}

export interface RouteManifest {
  version: number
  routes: RouteEntry[]
  pages: PageEntry[]
}

export const ROUTE_MANIFEST: RouteManifest = {
  version: 1,
  routes: [
    // Webhook & OAuth
    {
      path: 'src/app/webhook/route.ts',
      methods: { POST: 'routes.webhook.POST', GET: 'routes.webhook.GET' },
    },
    {
      path: 'src/app/callback/route.ts',
      methods: { GET: 'routes.oauth.callback.GET' },
    },

    // Worker routes
    {
      path: 'src/app/api/workers/register/route.ts',
      methods: { POST: 'routes.workers.register.POST' },
    },
    {
      path: 'src/app/api/workers/route.ts',
      methods: { GET: 'routes.workers.list.GET' },
    },
    {
      path: 'src/app/api/workers/[id]/route.ts',
      methods: { GET: 'routes.workers.detail.GET', DELETE: 'routes.workers.detail.DELETE' },
    },
    {
      path: 'src/app/api/workers/[id]/heartbeat/route.ts',
      methods: { POST: 'routes.workers.heartbeat.POST' },
    },
    {
      path: 'src/app/api/workers/[id]/poll/route.ts',
      methods: { GET: 'routes.workers.poll.GET' },
    },

    // Session routes
    {
      path: 'src/app/api/sessions/route.ts',
      methods: { GET: 'routes.sessions.list.GET' },
    },
    {
      path: 'src/app/api/sessions/[id]/route.ts',
      methods: { GET: 'routes.sessions.detail.GET' },
    },
    {
      path: 'src/app/api/sessions/[id]/claim/route.ts',
      methods: { POST: 'routes.sessions.claim.POST' },
    },
    {
      path: 'src/app/api/sessions/[id]/status/route.ts',
      methods: { POST: 'routes.sessions.status.POST', GET: 'routes.sessions.status.GET' },
    },
    {
      path: 'src/app/api/sessions/[id]/lock-refresh/route.ts',
      methods: { POST: 'routes.sessions.lockRefresh.POST' },
    },
    {
      path: 'src/app/api/sessions/[id]/prompts/route.ts',
      methods: { POST: 'routes.sessions.prompts.POST', GET: 'routes.sessions.prompts.GET' },
    },
    {
      path: 'src/app/api/sessions/[id]/transfer-ownership/route.ts',
      methods: { POST: 'routes.sessions.transferOwnership.POST' },
    },
    {
      path: 'src/app/api/sessions/[id]/activity/route.ts',
      methods: { POST: 'routes.sessions.activity.POST' },
    },
    {
      path: 'src/app/api/sessions/[id]/completion/route.ts',
      methods: { POST: 'routes.sessions.completion.POST' },
    },
    {
      path: 'src/app/api/sessions/[id]/external-urls/route.ts',
      methods: { POST: 'routes.sessions.externalUrls.POST' },
    },
    {
      path: 'src/app/api/sessions/[id]/progress/route.ts',
      methods: { POST: 'routes.sessions.progress.POST' },
    },
    {
      path: 'src/app/api/sessions/[id]/tool-error/route.ts',
      methods: { POST: 'routes.sessions.toolError.POST' },
    },

    // Public routes
    {
      path: 'src/app/api/public/stats/route.ts',
      methods: { GET: 'routes.public.stats.GET' },
    },
    {
      path: 'src/app/api/public/sessions/route.ts',
      methods: { GET: 'routes.public.sessions.GET' },
    },
    {
      path: 'src/app/api/public/sessions/[id]/route.ts',
      methods: { GET: 'routes.public.sessionDetail.GET' },
    },

    // Config route
    {
      path: 'src/app/api/config/route.ts',
      methods: { GET: 'routes.config.GET' },
    },

    // Cleanup route
    {
      path: 'src/app/api/cleanup/route.ts',
      methods: { POST: 'routes.cleanup.POST', GET: 'routes.cleanup.GET' },
    },

    // Issue tracker proxy (centralized API gateway for agents/governors)
    {
      path: 'src/app/api/issue-tracker-proxy/route.ts',
      methods: { POST: 'routes.issueTrackerProxy.POST', GET: 'routes.issueTrackerProxy.GET' },
    },
  ],
  pages: [
    {
      path: 'src/app/page.tsx',
      component: 'DashboardPage',
      exportName: 'DashboardPage',
      importAlias: 'DashboardPage as FleetPage',
    },
    {
      path: 'src/app/pipeline/page.tsx',
      component: 'PipelinePage',
      exportName: 'Pipeline',
    },
    {
      path: 'src/app/sessions/page.tsx',
      component: 'SessionPage',
      exportName: 'Sessions',
    },
    {
      path: 'src/app/sessions/[id]/page.tsx',
      component: 'SessionPage',
      exportName: 'SessionDetailPage',
      params: ['id'],
      propMapping: { id: 'sessionId' },
    },
    {
      path: 'src/app/settings/page.tsx',
      component: 'SettingsPage',
      exportName: 'Settings',
    },
  ],
}
