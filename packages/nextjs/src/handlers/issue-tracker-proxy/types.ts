/**
 * Types for the issue tracker proxy handler.
 */

import type { RouteConfig } from '../../types.js'

export interface ProxyHandlerConfig extends RouteConfig {
  /** Optional: override worker API key env var (default: WORKER_API_KEY) */
  workerApiKeyEnvVar?: string
}
