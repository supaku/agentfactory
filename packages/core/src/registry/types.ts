/**
 * Node Type Registry Types
 *
 * Interfaces for the node type metadata store that serves
 * canvas UI and execution engine with provider plugin information.
 */

/**
 * JSON Schema 7 type — a simplified representation for input/output schemas.
 * Uses Record<string, unknown> to avoid adding @types/json-schema dependency,
 * consistent with how the codebase handles schema objects elsewhere.
 */
export type JSONSchema7 = Record<string, unknown>

/** Provider category grouping (e.g., "Communication", "Project Management") */
export interface ProviderCategory {
  /** Unique category identifier */
  id: string
  /** Human-readable name */
  displayName: string
  /** Category description */
  description: string
  /** Icon identifier for the canvas UI */
  icon?: string
}

/** Metadata for a single node type (action/trigger/condition) in the registry */
export interface NodeTypeMetadata {
  /** Unique identifier for this node type */
  id: string
  /** Provider identifier (e.g., "linear", "slack") */
  providerId: string
  /** Action identifier within the provider (e.g., "create-issue", "send-message") */
  actionId: string
  /** Human-readable name */
  displayName: string
  /** Description of what this node type does */
  description: string
  /** Category this node type belongs to */
  category: string
  /** JSON Schema for the node's input fields */
  inputSchema: JSONSchema7
  /** JSON Schema for the node's output */
  outputSchema?: JSONSchema7
  /** Fields that support dynamic option loading */
  dynamicOptionFields?: string[]
}

/** Filter parameters for querying node types */
export interface NodeTypeQuery {
  /** Filter by category */
  category?: string
  /** Filter by provider */
  providerId?: string
}

/** Definition of a field that supports dynamic options (e.g., dropdown population) */
export interface DynamicOptionDefinition {
  /** Path to the field in the input schema */
  fieldPath: string
  /** Provider method to call for fetching options */
  providerMethod: string
  /** Other field paths whose values are needed as dependencies */
  dependencies?: string[]
}

/** A single option returned from dynamic option loading */
export interface DynamicOption {
  /** Value to store when selected */
  value: string
  /** Human-readable label to display */
  label: string
}

/** Result of a dynamic option loading call */
export type DynamicOptionResult = DynamicOption[]

/**
 * Provider plugin interface — defines the shape of a provider plugin
 * that can be loaded into the registry.
 *
 * This is the minimal interface needed by the registry. The full
 * ProviderPlugin interface is defined in SUP-1511.
 */
export interface ProviderPlugin {
  /** Unique provider identifier (e.g., "linear", "slack") */
  id: string
  /** Human-readable name */
  displayName: string
  /** Provider description */
  description: string
  /** Category metadata for this provider */
  category: ProviderCategory
  /** Action definitions provided by this plugin */
  actions: ActionDefinition[]
}

/** Action definition within a provider plugin */
export interface ActionDefinition {
  /** Unique action identifier within the provider */
  id: string
  /** Human-readable name */
  displayName: string
  /** Description of what this action does */
  description: string
  /** JSON Schema for the action's input fields */
  inputSchema: JSONSchema7
  /** JSON Schema for the action's output */
  outputSchema?: JSONSchema7
  /** Fields that support dynamic option loading */
  dynamicOptions?: DynamicOptionDefinition[]
  /** Execute the action (optional — not needed for registry metadata) */
  execute?: (input: Record<string, unknown>, context?: Record<string, unknown>) => Promise<unknown>
  /** Fetch dynamic options for a field */
  fetchDynamicOptions?: (
    fieldPath: string,
    context?: Record<string, unknown>,
  ) => Promise<DynamicOptionResult>
}
