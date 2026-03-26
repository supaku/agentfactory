import { describe, it, expect } from 'vitest'
import type {
  ActionDefinition,
  ActionResult,
  AuthResult,
  ConditionContext,
  ConditionDefinition,
  CredentialDefinition,
  CredentialField,
  DynamicOptionField,
  NormalizedEvent,
  ProviderExecutionContext,
  ProviderPlugin,
  TriggerDefinition,
  WebhookConfig,
  WebhookRegistration,
} from './index.js'

// ---------------------------------------------------------------------------
// Helpers — reusable valid implementations of the core interfaces
// ---------------------------------------------------------------------------

function createValidAction(overrides?: Partial<ActionDefinition>): ActionDefinition {
  return {
    id: 'create-issue',
    displayName: 'Create Issue',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    },
    outputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
    },
    execute: async (_input, _context) => ({ success: true, data: { id: '123' } }),
    ...overrides,
  }
}

function createValidTrigger(overrides?: Partial<TriggerDefinition>): TriggerDefinition {
  return {
    id: 'issue-created',
    displayName: 'Issue Created',
    eventType: 'issue.created',
    filterSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
    },
    normalizeEvent: (rawEvent: unknown) => ({
      id: 'evt-001',
      type: 'issue.created',
      timestamp: new Date('2025-01-15T12:00:00Z'),
      data: { project: 'backend' },
      raw: rawEvent,
    }),
    registerWebhook: async (_config) => ({
      id: 'wh-001',
      url: 'https://hooks.example.com/abc',
    }),
    deregisterWebhook: async (_registration) => {},
    ...overrides,
  }
}

function createValidCondition(overrides?: Partial<ConditionDefinition>): ConditionDefinition {
  return {
    id: 'is-high-priority',
    displayName: 'Is High Priority',
    evaluationSchema: {
      type: 'object',
      properties: { priority: { type: 'number' } },
    },
    evaluate: async (params, _context) => (params.priority as number) >= 3,
    ...overrides,
  }
}

function createValidCredential(overrides?: Partial<CredentialDefinition>): CredentialDefinition {
  return {
    id: 'oauth2-creds',
    authType: 'oauth2',
    requiredFields: [
      { name: 'clientId', label: 'Client ID', type: 'string' },
      { name: 'clientSecret', label: 'Client Secret', type: 'password', secret: true },
    ],
    authenticate: async (credentials) => {
      if (credentials.clientId && credentials.clientSecret) {
        return { valid: true, metadata: { scope: 'read write' } }
      }
      return { valid: false, error: 'Missing credentials' }
    },
    ...overrides,
  }
}

function createValidPlugin(overrides?: Partial<ProviderPlugin>): ProviderPlugin {
  return {
    id: 'github',
    displayName: 'GitHub',
    description: 'GitHub integration for issues, PRs, and repos',
    version: '1.0.0',
    icon: 'github-icon',
    actions: [createValidAction()],
    triggers: [createValidTrigger()],
    conditions: [createValidCondition()],
    credentials: [createValidCredential()],
    ...overrides,
  }
}

// ===========================================================================
// Tests
// ===========================================================================

describe('Provider Plugin Type System', () => {
  // -------------------------------------------------------------------------
  // 1. Interface Shape Tests
  // -------------------------------------------------------------------------

  describe('Interface Shape Tests', () => {
    describe('ActionDefinition', () => {
      it('accepts a valid action with all required fields', () => {
        const action: ActionDefinition = createValidAction()
        expect(action).toBeDefined()
        expect(action.id).toBe('create-issue')
        expect(action.displayName).toBe('Create Issue')
        expect(action.inputSchema).toBeDefined()
        expect(action.outputSchema).toBeDefined()
        expect(typeof action.execute).toBe('function')
      })

      it('accepts optional description and category fields', () => {
        const action: ActionDefinition = createValidAction({
          description: 'Creates a new issue in the tracker',
          category: 'Issues',
        })
        expect(action.description).toBe('Creates a new issue in the tracker')
        expect(action.category).toBe('Issues')
      })

      it('accepts dynamicOptions field', () => {
        const dynamicOpts: DynamicOptionField[] = [
          { fieldPath: 'projectId', dependsOn: ['orgId'] },
          { fieldPath: 'labelId' },
        ]
        const action: ActionDefinition = createValidAction({
          dynamicOptions: dynamicOpts,
        })
        expect(action.dynamicOptions).toHaveLength(2)
        expect(action.dynamicOptions![0].fieldPath).toBe('projectId')
        expect(action.dynamicOptions![0].dependsOn).toEqual(['orgId'])
        expect(action.dynamicOptions![1].dependsOn).toBeUndefined()
      })
    })

    describe('TriggerDefinition', () => {
      it('accepts a valid trigger with all required fields', () => {
        const trigger: TriggerDefinition = createValidTrigger()
        expect(trigger).toBeDefined()
        expect(trigger.id).toBe('issue-created')
        expect(trigger.displayName).toBe('Issue Created')
        expect(trigger.eventType).toBe('issue.created')
        expect(trigger.filterSchema).toBeDefined()
        expect(typeof trigger.normalizeEvent).toBe('function')
        expect(typeof trigger.registerWebhook).toBe('function')
        expect(typeof trigger.deregisterWebhook).toBe('function')
      })

      it('accepts optional description field', () => {
        const trigger: TriggerDefinition = createValidTrigger({
          description: 'Fires when a new issue is created',
        })
        expect(trigger.description).toBe('Fires when a new issue is created')
      })
    })

    describe('ConditionDefinition', () => {
      it('accepts a valid condition with all required fields', () => {
        const condition: ConditionDefinition = createValidCondition()
        expect(condition).toBeDefined()
        expect(condition.id).toBe('is-high-priority')
        expect(condition.displayName).toBe('Is High Priority')
        expect(condition.evaluationSchema).toBeDefined()
        expect(typeof condition.evaluate).toBe('function')
      })

      it('accepts optional description field', () => {
        const condition: ConditionDefinition = createValidCondition({
          description: 'Checks if an issue is marked as high priority',
        })
        expect(condition.description).toBe('Checks if an issue is marked as high priority')
      })
    })

    describe('CredentialDefinition', () => {
      it('accepts a valid credential with all required fields', () => {
        const cred: CredentialDefinition = createValidCredential()
        expect(cred).toBeDefined()
        expect(cred.id).toBe('oauth2-creds')
        expect(cred.authType).toBe('oauth2')
        expect(cred.requiredFields).toHaveLength(2)
        expect(typeof cred.authenticate).toBe('function')
      })

      it('accepts credential fields with all properties', () => {
        const field: CredentialField = {
          name: 'apiKey',
          label: 'API Key',
          type: 'password',
          secret: true,
          description: 'Your provider API key',
        }
        expect(field).toBeDefined()
        expect(field.secret).toBe(true)
        expect(field.description).toBe('Your provider API key')
      })

      it('accepts credential fields with only required properties', () => {
        const field: CredentialField = {
          name: 'endpoint',
          label: 'Endpoint URL',
          type: 'url',
        }
        expect(field).toBeDefined()
        expect(field.secret).toBeUndefined()
        expect(field.description).toBeUndefined()
      })
    })

    describe('ProviderPlugin', () => {
      it('accepts a valid plugin with all required fields', () => {
        const plugin: ProviderPlugin = createValidPlugin()
        expect(plugin).toBeDefined()
        expect(plugin.id).toBe('github')
        expect(plugin.displayName).toBe('GitHub')
        expect(plugin.version).toBe('1.0.0')
        expect(plugin.actions).toHaveLength(1)
        expect(plugin.triggers).toHaveLength(1)
        expect(plugin.conditions).toHaveLength(1)
        expect(plugin.credentials).toHaveLength(1)
      })

      it('accepts optional description and icon fields', () => {
        const plugin: ProviderPlugin = createValidPlugin()
        expect(plugin.description).toBe('GitHub integration for issues, PRs, and repos')
        expect(plugin.icon).toBe('github-icon')
      })

      it('accepts a plugin without optional fields', () => {
        const plugin: ProviderPlugin = createValidPlugin({
          description: undefined,
          icon: undefined,
        })
        expect(plugin.description).toBeUndefined()
        expect(plugin.icon).toBeUndefined()
      })
    })

    describe('Supporting Types', () => {
      it('ProviderExecutionContext has required credentials and optional env', () => {
        const ctx: ProviderExecutionContext = {
          credentials: { token: 'abc123' },
        }
        expect(ctx.credentials).toEqual({ token: 'abc123' })
        expect(ctx.env).toBeUndefined()

        const ctxWithEnv: ProviderExecutionContext = {
          credentials: { token: 'abc123' },
          env: { DEBUG: 'true' },
        }
        expect(ctxWithEnv.env).toEqual({ DEBUG: 'true' })
      })

      it('ActionResult has required success and optional data/error', () => {
        const successResult: ActionResult = { success: true, data: { id: '42' } }
        expect(successResult.success).toBe(true)
        expect(successResult.data).toEqual({ id: '42' })
        expect(successResult.error).toBeUndefined()

        const failResult: ActionResult = { success: false, error: 'Not found' }
        expect(failResult.success).toBe(false)
        expect(failResult.error).toBe('Not found')
        expect(failResult.data).toBeUndefined()
      })

      it('NormalizedEvent has all required fields', () => {
        const evt: NormalizedEvent = {
          id: 'evt-001',
          type: 'message.posted',
          timestamp: new Date('2025-01-15T12:00:00Z'),
          data: { channel: 'general', text: 'hello' },
          raw: { original: true },
        }
        expect(evt.id).toBe('evt-001')
        expect(evt.type).toBe('message.posted')
        expect(evt.timestamp).toBeInstanceOf(Date)
        expect(evt.data).toHaveProperty('channel')
        expect(evt.raw).toEqual({ original: true })
      })

      it('WebhookConfig has required url and optional secret/events', () => {
        const minimal: WebhookConfig = { url: 'https://hooks.example.com/abc' }
        expect(minimal.url).toBe('https://hooks.example.com/abc')
        expect(minimal.secret).toBeUndefined()
        expect(minimal.events).toBeUndefined()

        const full: WebhookConfig = {
          url: 'https://hooks.example.com/abc',
          secret: 'whsec_123',
          events: ['push', 'pull_request'],
        }
        expect(full.secret).toBe('whsec_123')
        expect(full.events).toEqual(['push', 'pull_request'])
      })

      it('WebhookRegistration has required id/url and optional metadata', () => {
        const minimal: WebhookRegistration = { id: 'wh-001', url: 'https://hooks.example.com/abc' }
        expect(minimal.metadata).toBeUndefined()

        const full: WebhookRegistration = {
          id: 'wh-001',
          url: 'https://hooks.example.com/abc',
          metadata: { createdAt: '2025-01-15' },
        }
        expect(full.metadata).toEqual({ createdAt: '2025-01-15' })
      })

      it('AuthResult has required valid and optional error/metadata', () => {
        const success: AuthResult = { valid: true, metadata: { userId: 'u1' } }
        expect(success.valid).toBe(true)
        expect(success.error).toBeUndefined()

        const failure: AuthResult = { valid: false, error: 'Invalid token' }
        expect(failure.valid).toBe(false)
        expect(failure.error).toBe('Invalid token')
      })

      it('ConditionContext has optional triggerEvent and stepOutputs', () => {
        const empty: ConditionContext = {}
        expect(empty.triggerEvent).toBeUndefined()
        expect(empty.stepOutputs).toBeUndefined()

        const withEvent: ConditionContext = {
          triggerEvent: {
            id: 'evt-001',
            type: 'issue.created',
            timestamp: new Date(),
            data: {},
            raw: null,
          },
          stepOutputs: { step1: { result: 'ok' } },
        }
        expect(withEvent.triggerEvent).toBeDefined()
        expect(withEvent.stepOutputs).toHaveProperty('step1')
      })

      it('DynamicOptionField has required fieldPath and optional dependsOn', () => {
        const simple: DynamicOptionField = { fieldPath: 'project' }
        expect(simple.fieldPath).toBe('project')
        expect(simple.dependsOn).toBeUndefined()

        const withDeps: DynamicOptionField = {
          fieldPath: 'repository',
          dependsOn: ['organization', 'team'],
        }
        expect(withDeps.dependsOn).toEqual(['organization', 'team'])
      })
    })
  })

  // -------------------------------------------------------------------------
  // 2. JSON Schema 7 Compatibility
  // -------------------------------------------------------------------------

  describe('JSON Schema 7 Compatibility', () => {
    it('accepts simple type schemas', () => {
      const action: ActionDefinition = createValidAction({
        inputSchema: { type: 'string' },
        outputSchema: { type: 'number' },
      })
      expect(action.inputSchema).toEqual({ type: 'string' })
      expect(action.outputSchema).toEqual({ type: 'number' })
    })

    it('accepts object schemas with properties and required', () => {
      const action: ActionDefinition = createValidAction({
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1 },
            description: { type: 'string' },
            priority: { type: 'integer', minimum: 1, maximum: 5 },
          },
          required: ['title'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
      })
      expect(action.inputSchema.type).toBe('object')
      expect(action.inputSchema.required).toEqual(['title'])
    })

    it('accepts array schemas with items', () => {
      const action: ActionDefinition = createValidAction({
        inputSchema: {
          type: 'object',
          properties: {
            tags: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
            },
          },
        },
        outputSchema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
            },
          },
        },
      })
      expect(action.inputSchema.type).toBe('object')
      expect(action.outputSchema.type).toBe('array')
    })

    it('accepts schemas with enum values', () => {
      const action: ActionDefinition = createValidAction({
        inputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['open', 'closed', 'in_progress'] },
          },
        },
        outputSchema: { type: 'string' },
      })
      const statusProp = (action.inputSchema.properties as Record<string, { enum?: string[] }>)?.status
      expect(statusProp?.enum).toEqual(['open', 'closed', 'in_progress'])
    })

    it('accepts schemas with oneOf', () => {
      const action: ActionDefinition = createValidAction({
        inputSchema: {
          oneOf: [
            { type: 'object', properties: { issueId: { type: 'string' } }, required: ['issueId'] },
            { type: 'object', properties: { issueKey: { type: 'string' } }, required: ['issueKey'] },
          ],
        },
        outputSchema: { type: 'object' },
      })
      expect(action.inputSchema.oneOf).toHaveLength(2)
    })

    it('accepts schemas with allOf', () => {
      const condition: ConditionDefinition = createValidCondition({
        evaluationSchema: {
          allOf: [
            { type: 'object', properties: { priority: { type: 'number' } } },
            { type: 'object', properties: { status: { type: 'string' } } },
          ],
        },
      })
      expect(condition.evaluationSchema.allOf).toHaveLength(2)
    })

    it('accepts schemas on trigger filterSchema', () => {
      const trigger: TriggerDefinition = createValidTrigger({
        filterSchema: {
          type: 'object',
          properties: {
            project: { type: 'string' },
            labels: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['project'],
        },
      })
      expect(trigger.filterSchema.type).toBe('object')
      expect(trigger.filterSchema.required).toEqual(['project'])
    })

    it('accepts schemas on condition evaluationSchema', () => {
      const condition: ConditionDefinition = createValidCondition({
        evaluationSchema: {
          type: 'object',
          properties: {
            threshold: { type: 'number', minimum: 0, maximum: 100 },
            mode: { type: 'string', enum: ['strict', 'lenient'] },
          },
        },
      })
      expect(condition.evaluationSchema.type).toBe('object')
    })
  })

  // -------------------------------------------------------------------------
  // 3. ProviderPlugin Composition
  // -------------------------------------------------------------------------

  describe('ProviderPlugin Composition', () => {
    it('accepts a plugin with all definition types populated', () => {
      const plugin: ProviderPlugin = createValidPlugin({
        actions: [
          createValidAction({ id: 'create-issue', displayName: 'Create Issue' }),
          createValidAction({ id: 'update-issue', displayName: 'Update Issue' }),
          createValidAction({ id: 'close-issue', displayName: 'Close Issue' }),
        ],
        triggers: [
          createValidTrigger({ id: 'issue-created', displayName: 'Issue Created', eventType: 'issue.created' }),
          createValidTrigger({ id: 'pr-merged', displayName: 'PR Merged', eventType: 'pr.merged' }),
        ],
        conditions: [
          createValidCondition({ id: 'is-high-priority', displayName: 'Is High Priority' }),
          createValidCondition({ id: 'is-assigned', displayName: 'Is Assigned' }),
        ],
        credentials: [
          createValidCredential({ id: 'oauth2', authType: 'oauth2' }),
          createValidCredential({ id: 'api-key', authType: 'apiKey' }),
        ],
      })

      expect(plugin.actions).toHaveLength(3)
      expect(plugin.triggers).toHaveLength(2)
      expect(plugin.conditions).toHaveLength(2)
      expect(plugin.credentials).toHaveLength(2)
    })

    it('accepts a plugin with empty arrays for all definition types', () => {
      const plugin: ProviderPlugin = createValidPlugin({
        actions: [],
        triggers: [],
        conditions: [],
        credentials: [],
      })

      expect(plugin.actions).toHaveLength(0)
      expect(plugin.triggers).toHaveLength(0)
      expect(plugin.conditions).toHaveLength(0)
      expect(plugin.credentials).toHaveLength(0)
    })

    it('allows a plugin with mixed populated and empty definition arrays', () => {
      const plugin: ProviderPlugin = createValidPlugin({
        actions: [createValidAction()],
        triggers: [],
        conditions: [createValidCondition()],
        credentials: [],
      })

      expect(plugin.actions).toHaveLength(1)
      expect(plugin.triggers).toHaveLength(0)
      expect(plugin.conditions).toHaveLength(1)
      expect(plugin.credentials).toHaveLength(0)
    })

    it('maintains correct action ids within a plugin', () => {
      const plugin: ProviderPlugin = createValidPlugin({
        actions: [
          createValidAction({ id: 'action-a' }),
          createValidAction({ id: 'action-b' }),
        ],
      })
      const ids = plugin.actions.map((a) => a.id)
      expect(ids).toEqual(['action-a', 'action-b'])
    })
  })

  // -------------------------------------------------------------------------
  // 4. Execute/Evaluate Contract Tests (Runtime)
  // -------------------------------------------------------------------------

  describe('Execute/Evaluate Contract Tests', () => {
    describe('ActionDefinition.execute()', () => {
      it('returns ActionResult with success: true and data on success', async () => {
        const action = createValidAction({
          execute: async (input, _context) => ({
            success: true,
            data: { id: 'new-123', title: input.title },
          }),
        })

        const context: ProviderExecutionContext = { credentials: { token: 'test-token' } }
        const result = await action.execute({ title: 'Test Issue' }, context)

        expect(result.success).toBe(true)
        expect(result.data).toEqual({ id: 'new-123', title: 'Test Issue' })
        expect(result.error).toBeUndefined()
      })

      it('returns ActionResult with success: false and error on failure', async () => {
        const action = createValidAction({
          execute: async (_input, _context) => ({
            success: false,
            error: 'Permission denied',
          }),
        })

        const context: ProviderExecutionContext = { credentials: { token: 'bad-token' } }
        const result = await action.execute({}, context)

        expect(result.success).toBe(false)
        expect(result.error).toBe('Permission denied')
        expect(result.data).toBeUndefined()
      })

      it('receives input and context arguments correctly', async () => {
        let capturedInput: Record<string, unknown> = {}
        let capturedContext: ProviderExecutionContext = { credentials: {} }

        const action = createValidAction({
          execute: async (input, context) => {
            capturedInput = input
            capturedContext = context
            return { success: true }
          },
        })

        const input = { title: 'Bug Report', priority: 1 }
        const context: ProviderExecutionContext = {
          credentials: { apiKey: 'key-123' },
          env: { REGION: 'us-east-1' },
        }

        await action.execute(input, context)

        expect(capturedInput).toEqual(input)
        expect(capturedContext.credentials).toEqual({ apiKey: 'key-123' })
        expect(capturedContext.env).toEqual({ REGION: 'us-east-1' })
      })
    })

    describe('TriggerDefinition.normalizeEvent()', () => {
      it('returns NormalizedEvent with all required fields', () => {
        const trigger = createValidTrigger()
        const rawEvent = { action: 'created', issue: { id: 42 } }

        const result = trigger.normalizeEvent(rawEvent)

        expect(result.id).toBe('evt-001')
        expect(result.type).toBe('issue.created')
        expect(result.timestamp).toBeInstanceOf(Date)
        expect(result.data).toBeDefined()
        expect(result.raw).toBe(rawEvent)
      })

      it('preserves the raw event as-is', () => {
        const trigger = createValidTrigger({
          normalizeEvent: (raw: unknown) => ({
            id: 'evt-002',
            type: 'pr.opened',
            timestamp: new Date(),
            data: { number: 99 },
            raw,
          }),
        })

        const rawEvent = { action: 'opened', pull_request: { number: 99, title: 'Fix bug' } }
        const result = trigger.normalizeEvent(rawEvent)

        expect(result.raw).toBe(rawEvent)
        expect(result.data).toEqual({ number: 99 })
      })
    })

    describe('TriggerDefinition.registerWebhook()', () => {
      it('returns WebhookRegistration with id and url', async () => {
        const trigger = createValidTrigger({
          registerWebhook: async (config) => ({
            id: 'wh-999',
            url: config.url,
            metadata: { events: config.events },
          }),
        })

        const config: WebhookConfig = {
          url: 'https://hooks.example.com/ingest',
          secret: 'whsec_test',
          events: ['push', 'issue'],
        }

        const registration = await trigger.registerWebhook(config)

        expect(registration.id).toBe('wh-999')
        expect(registration.url).toBe('https://hooks.example.com/ingest')
        expect(registration.metadata).toEqual({ events: ['push', 'issue'] })
      })
    })

    describe('TriggerDefinition.deregisterWebhook()', () => {
      it('completes without error given a valid registration', async () => {
        let capturedRegistration: WebhookRegistration | undefined

        const trigger = createValidTrigger({
          deregisterWebhook: async (registration) => {
            capturedRegistration = registration
          },
        })

        const registration: WebhookRegistration = {
          id: 'wh-001',
          url: 'https://hooks.example.com/abc',
        }

        await trigger.deregisterWebhook(registration)

        expect(capturedRegistration).toEqual(registration)
      })
    })

    describe('ConditionDefinition.evaluate()', () => {
      it('returns true when condition is met', async () => {
        const condition = createValidCondition()
        const result = await condition.evaluate({ priority: 5 }, {})
        expect(result).toBe(true)
      })

      it('returns false when condition is not met', async () => {
        const condition = createValidCondition()
        const result = await condition.evaluate({ priority: 1 }, {})
        expect(result).toBe(false)
      })

      it('receives ConditionContext with triggerEvent and stepOutputs', async () => {
        let capturedContext: ConditionContext = {}

        const condition = createValidCondition({
          evaluate: async (_params, context) => {
            capturedContext = context
            return true
          },
        })

        const ctx: ConditionContext = {
          triggerEvent: {
            id: 'evt-001',
            type: 'issue.created',
            timestamp: new Date('2025-01-15T12:00:00Z'),
            data: { priority: 5 },
            raw: {},
          },
          stepOutputs: {
            'step-1': { assignee: 'alice' },
          },
        }

        await condition.evaluate({}, ctx)

        expect(capturedContext.triggerEvent).toBeDefined()
        expect(capturedContext.triggerEvent!.id).toBe('evt-001')
        expect(capturedContext.stepOutputs).toHaveProperty('step-1')
      })
    })

    describe('CredentialDefinition.authenticate()', () => {
      it('returns AuthResult with valid: true on success', async () => {
        const cred = createValidCredential()
        const result = await cred.authenticate({
          clientId: 'id-123',
          clientSecret: 'secret-456',
        })

        expect(result.valid).toBe(true)
        expect(result.error).toBeUndefined()
        expect(result.metadata).toEqual({ scope: 'read write' })
      })

      it('returns AuthResult with valid: false and error on failure', async () => {
        const cred = createValidCredential()
        const result = await cred.authenticate({
          clientId: '',
          clientSecret: '',
        })

        expect(result.valid).toBe(false)
        expect(result.error).toBe('Missing credentials')
      })

      it('returns AuthResult with metadata on success', async () => {
        const cred = createValidCredential({
          authenticate: async (_credentials) => ({
            valid: true,
            metadata: { userId: 'u-1', org: 'acme', expiresIn: 3600 },
          }),
        })

        const result = await cred.authenticate({ token: 'valid-token' })
        expect(result.valid).toBe(true)
        expect(result.metadata).toHaveProperty('userId')
        expect(result.metadata).toHaveProperty('org')
        expect(result.metadata).toHaveProperty('expiresIn')
      })
    })
  })

  // -------------------------------------------------------------------------
  // 5. Auth Type Variant Tests
  // -------------------------------------------------------------------------

  describe('Auth Type Variant Tests', () => {
    it('accepts oauth2 credential definition with client ID and client secret', () => {
      const cred: CredentialDefinition = createValidCredential({
        id: 'github-oauth2',
        authType: 'oauth2',
        requiredFields: [
          { name: 'clientId', label: 'Client ID', type: 'string' },
          { name: 'clientSecret', label: 'Client Secret', type: 'password', secret: true },
        ],
      })

      expect(cred.authType).toBe('oauth2')
      expect(cred.requiredFields).toHaveLength(2)

      const clientIdField = cred.requiredFields.find((f) => f.name === 'clientId')
      expect(clientIdField).toBeDefined()
      expect(clientIdField!.type).toBe('string')

      const secretField = cred.requiredFields.find((f) => f.name === 'clientSecret')
      expect(secretField).toBeDefined()
      expect(secretField!.type).toBe('password')
      expect(secretField!.secret).toBe(true)
    })

    it('accepts apiKey credential definition with secret API key field', () => {
      const cred: CredentialDefinition = createValidCredential({
        id: 'openai-api-key',
        authType: 'apiKey',
        requiredFields: [
          {
            name: 'apiKey',
            label: 'API Key',
            type: 'password',
            secret: true,
            description: 'Your OpenAI API key starting with sk-',
          },
        ],
      })

      expect(cred.authType).toBe('apiKey')
      expect(cred.requiredFields).toHaveLength(1)

      const apiKeyField = cred.requiredFields[0]
      expect(apiKeyField.name).toBe('apiKey')
      expect(apiKeyField.secret).toBe(true)
      expect(apiKeyField.description).toContain('sk-')
    })

    it('accepts bearer credential definition with bearer token field', () => {
      const cred: CredentialDefinition = createValidCredential({
        id: 'slack-bearer',
        authType: 'bearer',
        requiredFields: [
          {
            name: 'bearerToken',
            label: 'Bearer Token',
            type: 'password',
            secret: true,
            description: 'OAuth bearer token for Slack API',
          },
        ],
      })

      expect(cred.authType).toBe('bearer')
      expect(cred.requiredFields).toHaveLength(1)

      const tokenField = cred.requiredFields[0]
      expect(tokenField.name).toBe('bearerToken')
      expect(tokenField.type).toBe('password')
      expect(tokenField.secret).toBe(true)
    })

    it('each auth type can successfully authenticate', async () => {
      const oauth2 = createValidCredential({
        authType: 'oauth2',
        authenticate: async () => ({ valid: true }),
      })
      const apiKey = createValidCredential({
        authType: 'apiKey',
        authenticate: async () => ({ valid: true }),
      })
      const bearer = createValidCredential({
        authType: 'bearer',
        authenticate: async () => ({ valid: true }),
      })

      const [oauth2Result, apiKeyResult, bearerResult] = await Promise.all([
        oauth2.authenticate({ clientId: 'id', clientSecret: 'secret' }),
        apiKey.authenticate({ apiKey: 'sk-test' }),
        bearer.authenticate({ bearerToken: 'xoxb-test' }),
      ])

      expect(oauth2Result.valid).toBe(true)
      expect(apiKeyResult.valid).toBe(true)
      expect(bearerResult.valid).toBe(true)
    })

    it('each auth type can return authentication failure', async () => {
      const oauth2 = createValidCredential({
        authType: 'oauth2',
        authenticate: async () => ({ valid: false, error: 'Invalid client credentials' }),
      })
      const apiKey = createValidCredential({
        authType: 'apiKey',
        authenticate: async () => ({ valid: false, error: 'API key revoked' }),
      })
      const bearer = createValidCredential({
        authType: 'bearer',
        authenticate: async () => ({ valid: false, error: 'Token expired' }),
      })

      const [oauth2Result, apiKeyResult, bearerResult] = await Promise.all([
        oauth2.authenticate({}),
        apiKey.authenticate({}),
        bearer.authenticate({}),
      ])

      expect(oauth2Result.valid).toBe(false)
      expect(oauth2Result.error).toBe('Invalid client credentials')
      expect(apiKeyResult.valid).toBe(false)
      expect(apiKeyResult.error).toBe('API key revoked')
      expect(bearerResult.valid).toBe(false)
      expect(bearerResult.error).toBe('Token expired')
    })
  })
})
