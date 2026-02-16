/**
 * Core types for @supaku/agentfactory-nextjs
 *
 * These types define the configuration interfaces that consumers
 * must implement to use the extracted route handlers.
 */

import type { NextRequest, NextResponse } from 'next/server'
import type { LinearAgentClient, AgentWorkType, SubIssueStatus } from '@supaku/agentfactory-linear'

/**
 * Resolves a Linear client for a given organization.
 * Consumers implement this to handle workspace-specific OAuth tokens.
 */
export interface LinearClientResolver {
  getClient(organizationId?: string): Promise<LinearAgentClient> | LinearAgentClient
}

/**
 * Base configuration for routes that need Linear API access.
 */
export interface RouteConfig {
  linearClient: LinearClientResolver
  appUrl?: string // falls back to NEXT_PUBLIC_APP_URL
}

/**
 * Auto-trigger configuration for webhook processing.
 */
export interface AutoTriggerConfig {
  enableAutoQA: boolean
  enableAutoAcceptance: boolean
  autoQARequireAgentWorked: boolean
  autoAcceptanceRequireAgentWorked: boolean
  autoQAProjects: string[]
  autoAcceptanceProjects: string[]
  autoQAExcludeLabels: string[]
  autoAcceptanceExcludeLabels: string[]
}

/**
 * Configuration for the webhook processor.
 *
 * `generatePrompt` is optional — if not provided, falls back to
 * `defaultGeneratePrompt` from @supaku/agentfactory-linear.
 */
export interface WebhookConfig extends RouteConfig {
  webhookSecret?: string // falls back to LINEAR_WEBHOOK_SECRET
  generatePrompt?: (identifier: string, workType: AgentWorkType, mentionContext?: string) => string
  detectWorkTypeFromPrompt?: (prompt: string, validWorkTypes: AgentWorkType[]) => AgentWorkType | undefined
  getPriority?: (workType: AgentWorkType) => number
  autoTrigger?: AutoTriggerConfig
  buildParentQAContext?: (identifier: string, subIssues: SubIssueStatus[]) => string
  buildParentAcceptanceContext?: (identifier: string, subIssues: SubIssueStatus[]) => string
  /** Linear project names this server handles. Empty/undefined = all projects. */
  projects?: string[]
}

/**
 * Resolved webhook config with all defaults applied.
 * Used internally by webhook handlers — generatePrompt is guaranteed to be set.
 */
export interface ResolvedWebhookConfig extends RouteConfig {
  webhookSecret?: string
  generatePrompt: (identifier: string, workType: AgentWorkType, mentionContext?: string) => string
  detectWorkTypeFromPrompt?: (prompt: string, validWorkTypes: AgentWorkType[]) => AgentWorkType | undefined
  getPriority?: (workType: AgentWorkType) => number
  autoTrigger?: AutoTriggerConfig
  buildParentQAContext?: (identifier: string, subIssues: SubIssueStatus[]) => string
  buildParentAcceptanceContext?: (identifier: string, subIssues: SubIssueStatus[]) => string
  /** Linear project names this server handles. Empty/undefined = all projects. */
  projects?: string[]
}

/**
 * Configuration for cron-authenticated routes.
 */
export interface CronConfig {
  cronSecret?: string // falls back to CRON_SECRET
}

/**
 * Standard Next.js route handler signature.
 *
 * Uses `any` for the context parameter because Next.js App Router
 * provides different shapes depending on the route segment (static
 * routes get no context, dynamic `[id]` routes get `{ params }`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RouteHandler = (...args: any[]) => Promise<NextResponse>
