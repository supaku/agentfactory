/**
 * A2A Protocol Types
 *
 * TypeScript type definitions for the Agent-to-Agent (A2A) protocol.
 * Covers AgentCard discovery, JSON-RPC messaging, task lifecycle,
 * and Server-Sent Events (SSE) streaming.
 */

// ---------------------------------------------------------------------------
// AgentCard
// ---------------------------------------------------------------------------

/** Describes an agent's identity, capabilities, and discoverable skills */
export interface A2aAgentCard {
  name: string
  description: string
  url: string
  version: string
  capabilities: A2aCapabilities
  skills: A2aSkill[]
  authentication?: A2aAuthScheme[]
  defaultInputContentTypes?: string[]
  defaultOutputContentTypes?: string[]
}

/** Feature flags advertised by the agent */
export interface A2aCapabilities {
  streaming: boolean
  pushNotifications: boolean
  stateTransitionHistory: boolean
}

/** A discrete capability the agent can perform */
export interface A2aSkill {
  id: string
  name: string
  description: string
  tags?: string[]
  examples?: string[]
}

/** Authentication scheme supported by the agent endpoint */
export interface A2aAuthScheme {
  type: 'apiKey' | 'http' | 'oauth2'
  /** For http type, e.g. 'bearer' */
  scheme?: string
  /** For apiKey type, e.g. 'header' */
  in?: string
  /** For apiKey type, the header name */
  name?: string
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

/** A JSON-RPC 2.0 request object */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: Record<string, unknown>
}

/** A JSON-RPC 2.0 response object */
export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: JsonRpcError
}

/** A JSON-RPC 2.0 error object */
export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

// ---------------------------------------------------------------------------
// A2A Task lifecycle
// ---------------------------------------------------------------------------

/** Represents a unit of work managed by the agent */
export interface A2aTask {
  id: string
  status: A2aTaskStatus
  messages: A2aMessage[]
  artifacts: A2aArtifact[]
  metadata?: Record<string, unknown>
}

/** Possible states of an A2A task */
export type A2aTaskStatus =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'

/** A message exchanged between user and agent */
export interface A2aMessage {
  role: 'user' | 'agent'
  parts: A2aPart[]
  metadata?: Record<string, unknown>
}

/** A content part within a message or artifact */
export type A2aPart = A2aTextPart | A2aFilePart | A2aDataPart

/** Plain text content part */
export interface A2aTextPart {
  type: 'text'
  text: string
}

/** File content part (URI or inline bytes) */
export interface A2aFilePart {
  type: 'file'
  file: { name: string; mimeType: string; uri?: string; bytes?: string }
}

/** Structured data content part */
export interface A2aDataPart {
  type: 'data'
  data: Record<string, unknown>
}

/** An output artifact produced by the agent */
export interface A2aArtifact {
  name: string
  description?: string
  parts: A2aPart[]
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// SSE streaming events
// ---------------------------------------------------------------------------

/** Notifies the client of a task status change */
export interface A2aTaskStatusUpdateEvent {
  type: 'TaskStatusUpdate'
  taskId: string
  status: A2aTaskStatus
  message?: A2aMessage
  final: boolean
}

/** Notifies the client of a new or updated artifact */
export interface A2aTaskArtifactUpdateEvent {
  type: 'TaskArtifactUpdate'
  taskId: string
  artifact: A2aArtifact
}

/** Union of all SSE event types emitted during task streaming */
export type A2aTaskEvent = A2aTaskStatusUpdateEvent | A2aTaskArtifactUpdateEvent
