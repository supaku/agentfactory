/**
 * Environment Variable Validation
 *
 * Validates required environment variables on startup.
 * Fails fast if critical security variables are missing in production.
 */

import { createLogger } from './logger.js'

const log = createLogger('env-validation')

/**
 * Configuration for environment validation
 */
export interface EnvValidationConfig {
  /** Variable names required in production */
  requiredVars?: string[]
  /** Variables that need minimum length validation */
  minLengthVars?: Array<{ name: string; minLength: number }>
}

/**
 * Default required environment variables for production
 * These are critical for security and must be present
 */
const DEFAULT_REQUIRED_VARS = [
  'LINEAR_WEBHOOK_SECRET',
  'CRON_SECRET',
  'WORKER_API_KEY',
  'SESSION_HASH_SALT',
]

/**
 * Default minimum length validations
 */
const DEFAULT_MIN_LENGTH_VARS = [
  { name: 'SESSION_HASH_SALT', minLength: 32 },
]

/**
 * Check if running in production environment
 */
function isProduction(): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.VERCEL_ENV === 'production'
  )
}

/**
 * Validation result
 */
export interface EnvValidationResult {
  valid: boolean
  missing: string[]
  warnings: string[]
}

/**
 * Validate environment variables
 *
 * In production: All required vars must be present
 * In development: Log warnings for missing vars but don't fail
 *
 * @param config - Optional configuration to override defaults
 * @returns Validation result with missing vars
 */
export function validateEnv(config?: EnvValidationConfig): EnvValidationResult {
  const missing: string[] = []
  const warnings: string[] = []
  const requiredVars = config?.requiredVars ?? DEFAULT_REQUIRED_VARS
  const minLengthVars = config?.minLengthVars ?? DEFAULT_MIN_LENGTH_VARS

  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      if (isProduction()) {
        missing.push(varName)
      } else {
        warnings.push(varName)
      }
    }
  }

  // Additional validation for minimum length variables
  for (const { name, minLength } of minLengthVars) {
    const value = process.env[name]
    if (value && value.length < minLength) {
      const msg = `${name} should be at least ${minLength} characters for security`
      if (isProduction()) {
        missing.push(`${name} (too short)`)
      } else {
        warnings.push(msg)
      }
    }
  }

  return {
    valid: missing.length === 0,
    missing,
    warnings,
  }
}

/**
 * Validate and fail fast if critical vars are missing
 *
 * Call this at application startup to ensure required
 * environment variables are configured.
 *
 * @param config - Optional configuration to override defaults
 * @throws Error if required vars are missing in production
 */
export function validateEnvOrThrow(config?: EnvValidationConfig): void {
  const result = validateEnv(config)

  // Log warnings for development
  if (result.warnings.length > 0) {
    log.warn('Missing environment variables (development mode)', {
      variables: result.warnings,
      hint: 'These are required in production',
    })
  }

  // Fail in production if required vars are missing
  if (!result.valid) {
    const errorMsg = `Missing required environment variables: ${result.missing.join(', ')}`
    log.error(errorMsg, {
      missing: result.missing,
      environment: process.env.NODE_ENV,
    })
    throw new Error(errorMsg)
  }

  log.debug('Environment validation passed')
}

/**
 * Check if webhook signature verification is configured
 */
export function isWebhookSecretConfigured(): boolean {
  return !!process.env.LINEAR_WEBHOOK_SECRET
}

/**
 * Check if cron authentication is configured
 */
export function isCronSecretConfigured(): boolean {
  return !!process.env.CRON_SECRET
}

/**
 * Check if session hashing is configured
 */
export function isSessionHashConfigured(): boolean {
  const salt = process.env.SESSION_HASH_SALT
  return !!salt && salt.length >= 32
}

/**
 * Get session hash salt
 * @param saltEnvVar - Environment variable name for the salt (default: SESSION_HASH_SALT)
 * @throws Error if not configured
 */
export function getSessionHashSalt(saltEnvVar = 'SESSION_HASH_SALT'): string {
  const salt = process.env[saltEnvVar]
  if (!salt) {
    throw new Error(`${saltEnvVar} not configured`)
  }
  return salt
}
