/**
 * Provider Plugin Interfaces
 *
 * Defines the core type system for provider plugins — integrations that
 * expose actions, triggers, and conditions (e.g. Slack, GitHub, Jira).
 *
 * This is SEPARATE from AgentProvider (types.ts), which handles agent
 * process management. ProviderPlugin handles integration capabilities.
 */

import type { JSONSchema7 } from 'json-schema'

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/** A single credential field required by a provider's authentication */
export interface CredentialField {
  /** Machine-readable field name */
  name: string
  /** Human-readable label */
  label: string
  /** Input type hint for credential UIs */
  type: 'string' | 'url' | 'password'
  /** Whether this field contains a secret value */
  secret?: boolean
  /** Help text describing the field */
  description?: string
}

/** Result of validating provider credentials */
export interface AuthResult {
  /** Whether authentication succeeded */
  valid: boolean
  /** Error message when authentication fails */
  error?: string
  /** Additional metadata returned by the auth check */
  metadata?: Record<string, unknown>
}

/** Describes a field whose options are resolved at runtime */
export interface DynamicOptionField {
  /** Dot-path to the field within the input schema */
  fieldPath: string
  /** Other field paths whose values must be resolved first */
  dependsOn?: string[]
}

/** Runtime context passed to action and trigger executors */
export interface ProviderExecutionContext {
  /** Resolved credential values for the provider */
  credentials: Record<string, string>
  /** Optional environment variables */
  env?: Record<string, string>
}

/** Result returned by an action execution */
export interface ActionResult {
  /** Whether the action completed successfully */
  success: boolean
  /** Payload returned by the action on success */
  data?: unknown
  /** Error message when the action fails */
  error?: string
}

/** A provider event normalized to a common shape */
export interface NormalizedEvent {
  /** Unique event identifier */
  id: string
  /** Event type (e.g. 'issue.created', 'message.posted') */
  type: string
  /** When the event occurred */
  timestamp: Date
  /** Structured event payload */
  data: Record<string, unknown>
  /** Original un-normalized event from the provider */
  raw: unknown
}

/** Configuration for registering a webhook with a provider */
export interface WebhookConfig {
  /** The URL the provider should deliver events to */
  url: string
  /** Shared secret for verifying webhook payloads */
  secret?: string
  /** Event types to subscribe to */
  events?: string[]
}

/** Handle returned after a webhook is registered */
export interface WebhookRegistration {
  /** Provider-assigned webhook identifier */
  id: string
  /** The registered webhook URL */
  url: string
  /** Provider-specific registration metadata */
  metadata?: Record<string, unknown>
}

/** Context available when evaluating a condition */
export interface ConditionContext {
  /** The trigger event that initiated the workflow, if any */
  triggerEvent?: NormalizedEvent
  /** Outputs from previous workflow steps, keyed by step id */
  stepOutputs?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Core interfaces
// ---------------------------------------------------------------------------

/** Defines how a provider authenticates (OAuth2, API key, bearer token) */
export interface CredentialDefinition {
  /** Unique credential identifier within the provider */
  id: string
  /** Authentication strategy */
  authType: 'oauth2' | 'apiKey' | 'bearer'
  /** Fields the user must supply */
  requiredFields: CredentialField[]
  /** Validate the supplied credentials against the provider */
  authenticate(credentials: Record<string, string>): Promise<AuthResult>
}

/** An operation that can be performed against a provider */
export interface ActionDefinition {
  /** Unique action identifier within the provider */
  id: string
  /** Human-readable action name */
  displayName: string
  /** Brief description of what the action does */
  description?: string
  /** Grouping category for UI organization */
  category?: string
  /** JSON Schema describing the action's input parameters */
  inputSchema: JSONSchema7
  /** JSON Schema describing the action's output shape */
  outputSchema: JSONSchema7
  /** Fields whose options are resolved dynamically at runtime */
  dynamicOptions?: DynamicOptionField[]
  /** Execute the action with the given input and credentials */
  execute(input: Record<string, unknown>, context: ProviderExecutionContext): Promise<ActionResult>
}

/** An event source that can initiate workflows */
export interface TriggerDefinition {
  /** Unique trigger identifier within the provider */
  id: string
  /** Human-readable trigger name */
  displayName: string
  /** Brief description of the trigger */
  description?: string
  /** The type of event this trigger produces */
  eventType: string
  /** JSON Schema for filtering which events match */
  filterSchema: JSONSchema7
  /** Convert a raw provider event into a NormalizedEvent */
  normalizeEvent(rawEvent: unknown): NormalizedEvent
  /** Register a webhook with the provider to receive events */
  registerWebhook(config: WebhookConfig): Promise<WebhookRegistration>
  /** Remove a previously registered webhook */
  deregisterWebhook(registration: WebhookRegistration): Promise<void>
}

/** A boolean predicate used for conditional branching in workflows */
export interface ConditionDefinition {
  /** Unique condition identifier within the provider */
  id: string
  /** Human-readable condition name */
  displayName: string
  /** Brief description of the condition */
  description?: string
  /** JSON Schema describing the evaluation parameters */
  evaluationSchema: JSONSchema7
  /** Evaluate the condition against the given parameters and context */
  evaluate(params: Record<string, unknown>, context: ConditionContext): Promise<boolean>
}

/** A provider plugin that bundles actions, triggers, conditions, and credentials */
export interface ProviderPlugin {
  /** Unique provider identifier (e.g. 'slack', 'github', 'jira') */
  id: string
  /** Human-readable provider name */
  displayName: string
  /** Brief description of the provider */
  description?: string
  /** Semantic version of the plugin */
  version: string
  /** Icon identifier or URL for the provider */
  icon?: string
  /** Actions this provider exposes */
  actions: ActionDefinition[]
  /** Triggers (event sources) this provider exposes */
  triggers: TriggerDefinition[]
  /** Conditions this provider exposes */
  conditions: ConditionDefinition[]
  /** Credential definitions for authenticating with this provider */
  credentials: CredentialDefinition[]
}
