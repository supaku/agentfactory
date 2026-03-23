import { describe, it, expect } from 'vitest'
import { SymbolExtractor } from '../symbol-extractor.js'
import { TypeScriptExtractor } from '../typescript-extractor.js'

const sampleTS = `
import { z } from 'zod'
import type { Foo } from './foo'

/** Configuration interface */
export interface Config {
  name: string
  version: number
}

export type Result<T> = { data: T; error?: string }

export const DEFAULT_TIMEOUT = 5000

/** Main handler function */
export async function handleRequest(req: Request): Promise<Response> {
  return new Response('ok')
}

export const processData = (input: string) => {
  return input.trim()
}

export class UserService {
  private db: Database

  constructor(db: Database) {
    this.db = db
  }

  async getUser(id: string): Promise<User> {
    return this.db.find(id)
  }

  async deleteUser(id: string): Promise<void> {
    await this.db.delete(id)
  }
}

export enum Status {
  Active = 'active',
  Inactive = 'inactive',
}

@deprecated
class OldService {}
`

const sampleJS = `
const express = require('express')
const { Router } = require('express')

function createServer(port) {
  const app = express()
  return app.listen(port)
}

class APIClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl
  }

  async fetch(path) {
    return fetch(this.baseUrl + path)
  }
}

const helper = (x) => x * 2

module.exports = { createServer, APIClient }
`

describe('TypeScriptExtractor', () => {
  const extractor = new TypeScriptExtractor()

  it('extracts imports', () => {
    const result = extractor.extract(sampleTS, 'sample.ts')
    expect(result.imports).toContain('zod')
    expect(result.imports).toContain('./foo')
  })

  it('extracts interface', () => {
    const result = extractor.extract(sampleTS, 'sample.ts')
    const iface = result.symbols.find(s => s.name === 'Config' && s.kind === 'interface')
    expect(iface).toBeDefined()
    expect(iface!.exported).toBe(true)
  })

  it('extracts type alias', () => {
    const result = extractor.extract(sampleTS, 'sample.ts')
    const type = result.symbols.find(s => s.name === 'Result' && s.kind === 'type')
    expect(type).toBeDefined()
    expect(type!.exported).toBe(true)
  })

  it('extracts exported variable', () => {
    const result = extractor.extract(sampleTS, 'sample.ts')
    const v = result.symbols.find(s => s.name === 'DEFAULT_TIMEOUT' && s.kind === 'variable')
    expect(v).toBeDefined()
    expect(v!.exported).toBe(true)
  })

  it('extracts async function with JSDoc', () => {
    const result = extractor.extract(sampleTS, 'sample.ts')
    const fn = result.symbols.find(s => s.name === 'handleRequest' && s.kind === 'function')
    expect(fn).toBeDefined()
    expect(fn!.exported).toBe(true)
    expect(fn!.documentation).toContain('Main handler function')
  })

  it('extracts arrow function', () => {
    const result = extractor.extract(sampleTS, 'sample.ts')
    const fn = result.symbols.find(s => s.name === 'processData' && s.kind === 'function')
    expect(fn).toBeDefined()
    expect(fn!.exported).toBe(true)
  })

  it('extracts class with methods', () => {
    const result = extractor.extract(sampleTS, 'sample.ts')
    const cls = result.symbols.find(s => s.name === 'UserService' && s.kind === 'class')
    expect(cls).toBeDefined()
    expect(cls!.exported).toBe(true)

    const methods = result.symbols.filter(s => s.parentName === 'UserService' && s.kind === 'method')
    const methodNames = methods.map(m => m.name)
    expect(methodNames).toContain('getUser')
    expect(methodNames).toContain('deleteUser')
  })

  it('extracts enum', () => {
    const result = extractor.extract(sampleTS, 'sample.ts')
    const en = result.symbols.find(s => s.name === 'Status' && s.kind === 'enum')
    expect(en).toBeDefined()
  })

  it('extracts decorators', () => {
    const result = extractor.extract(sampleTS, 'sample.ts')
    const dec = result.symbols.find(s => s.name === 'deprecated' && s.kind === 'decorator')
    expect(dec).toBeDefined()
  })

  it('tracks exports', () => {
    const result = extractor.extract(sampleTS, 'sample.ts')
    expect(result.exports).toContain('Config')
    expect(result.exports).toContain('handleRequest')
    expect(result.exports).toContain('UserService')
  })

  it('sets correct language for .ts files', () => {
    const result = extractor.extract(sampleTS, 'sample.ts')
    expect(result.language).toBe('typescript')
  })

  it('sets correct language for .js files', () => {
    const result = extractor.extract(sampleJS, 'sample.js')
    expect(result.language).toBe('javascript')
  })

  it('extracts JavaScript functions and classes', () => {
    const result = extractor.extract(sampleJS, 'sample.js')
    const fn = result.symbols.find(s => s.name === 'createServer' && s.kind === 'function')
    expect(fn).toBeDefined()

    const cls = result.symbols.find(s => s.name === 'APIClient' && s.kind === 'class')
    expect(cls).toBeDefined()
  })

  it('extracts JS arrow functions', () => {
    const result = extractor.extract(sampleJS, 'sample.js')
    const fn = result.symbols.find(s => s.name === 'helper' && s.kind === 'function')
    expect(fn).toBeDefined()
  })
})

describe('SymbolExtractor', () => {
  const extractor = new SymbolExtractor()

  it('detects typescript language', () => {
    expect(extractor.detectLanguage('src/main.ts')).toBe('typescript')
    expect(extractor.detectLanguage('src/app.tsx')).toBe('typescript')
  })

  it('detects javascript language', () => {
    expect(extractor.detectLanguage('lib/utils.js')).toBe('javascript')
    expect(extractor.detectLanguage('lib/utils.mjs')).toBe('javascript')
  })

  it('detects unknown language', () => {
    expect(extractor.detectLanguage('main.py')).toBe('python')
    expect(extractor.detectLanguage('readme.md')).toBe('unknown')
  })

  it('supports typescript and javascript', () => {
    expect(extractor.supportsLanguage('typescript')).toBe(true)
    expect(extractor.supportsLanguage('javascript')).toBe(true)
    expect(extractor.supportsLanguage('python')).toBe(false)
  })

  it('extracts from source', () => {
    const result = extractor.extractFromSource(sampleTS, 'test.ts')
    expect(result.symbols.length).toBeGreaterThan(0)
    expect(result.language).toBe('typescript')
  })

  it('returns empty for unsupported language', () => {
    const result = extractor.extractFromSource('def hello(): pass', 'test.py')
    expect(result.symbols).toHaveLength(0)
    expect(result.language).toBe('python')
  })
})
