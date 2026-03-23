import type { CodeSymbol, FileAST, SymbolKind } from '../types.js'
import { TypeScriptExtractor } from './typescript-extractor.js'

export interface LanguageExtractor {
  languages: string[]
  extract(source: string, filePath: string): FileAST
}

const EXTENSION_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
}

export class SymbolExtractor {
  private extractors: Map<string, LanguageExtractor> = new Map()

  constructor() {
    const tsExtractor = new TypeScriptExtractor()
    for (const lang of tsExtractor.languages) {
      this.extractors.set(lang, tsExtractor)
    }
  }

  registerExtractor(extractor: LanguageExtractor): void {
    for (const lang of extractor.languages) {
      this.extractors.set(lang, extractor)
    }
  }

  extractFromSource(source: string, filePath: string): FileAST {
    const language = this.detectLanguage(filePath)
    const extractor = this.extractors.get(language)
    if (!extractor) {
      return {
        filePath,
        language,
        symbols: [],
        imports: [],
        exports: [],
      }
    }
    return extractor.extract(source, filePath)
  }

  detectLanguage(filePath: string): string {
    const ext = filePath.slice(filePath.lastIndexOf('.'))
    return EXTENSION_MAP[ext] ?? 'unknown'
  }

  supportsLanguage(language: string): boolean {
    return this.extractors.has(language)
  }
}
