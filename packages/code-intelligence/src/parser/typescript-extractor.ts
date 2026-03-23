import type { CodeSymbol, FileAST, SymbolKind } from '../types.js'
import type { LanguageExtractor } from './symbol-extractor.js'

/** Regex-based TypeScript/JavaScript symbol extractor (no native deps). */
export class TypeScriptExtractor implements LanguageExtractor {
  languages = ['typescript', 'javascript']

  extract(source: string, filePath: string): FileAST {
    const lines = source.split('\n')
    const symbols: CodeSymbol[] = []
    const imports: string[] = []
    const exports: string[] = []
    const language = filePath.endsWith('.js') || filePath.endsWith('.jsx') ||
      filePath.endsWith('.mjs') || filePath.endsWith('.cjs')
      ? 'javascript' : 'typescript'

    let currentJSDoc: string | undefined
    let inBlockComment = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()

      // Track JSDoc comments
      if (trimmed.startsWith('/**')) {
        const endIdx = source.indexOf('*/', source.indexOf('/**', this.lineOffset(lines, i)))
        if (endIdx !== -1) {
          const commentStart = this.lineOffset(lines, i)
          currentJSDoc = source.slice(commentStart, endIdx + 2).trim()
        }
        if (trimmed.includes('*/')) {
          // single-line JSDoc
        } else {
          inBlockComment = true
        }
        continue
      }
      if (inBlockComment) {
        if (trimmed.includes('*/')) {
          inBlockComment = false
        }
        continue
      }
      if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
        continue
      }

      // Imports
      const importMatch = trimmed.match(/^import\s+(?:(?:type\s+)?(?:\{[^}]*\}|[\w*]+(?:\s+as\s+\w+)?)\s+from\s+)?['"]([^'"]+)['"]/s)
      if (importMatch) {
        imports.push(importMatch[1])
        continue
      }
      // Dynamic imports
      const dynImportMatch = trimmed.match(/import\(['"]([^'"]+)['"]\)/)
      if (dynImportMatch) {
        imports.push(dynImportMatch[1])
      }

      const isExported = trimmed.startsWith('export ')
      const effective = isExported ? trimmed.replace(/^export\s+(default\s+)?/, '') : trimmed

      // Function declarations
      const funcMatch = effective.match(/^(?:async\s+)?function\s*\*?\s+(\w+)/)
      if (funcMatch) {
        const name = funcMatch[1]
        const sig = this.extractSignature(effective)
        symbols.push(this.makeSymbol(name, 'function', filePath, i, isExported, sig, currentJSDoc, language))
        if (isExported) exports.push(name)
        currentJSDoc = undefined
        continue
      }

      // Arrow / const functions
      const arrowMatch = effective.match(/^(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/)
      if (arrowMatch) {
        const name = arrowMatch[1]
        symbols.push(this.makeSymbol(name, 'function', filePath, i, isExported, effective.split('=>')[0].trim(), currentJSDoc, language))
        if (isExported) exports.push(name)
        currentJSDoc = undefined
        continue
      }

      // Const function expression
      const funcExprMatch = effective.match(/^(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?function/)
      if (funcExprMatch) {
        const name = funcExprMatch[1]
        symbols.push(this.makeSymbol(name, 'function', filePath, i, isExported, undefined, currentJSDoc, language))
        if (isExported) exports.push(name)
        currentJSDoc = undefined
        continue
      }

      // Class declarations
      const classMatch = effective.match(/^(?:abstract\s+)?class\s+(\w+)/)
      if (classMatch) {
        const name = classMatch[1]
        const endLine = this.findBlockEnd(lines, i)
        symbols.push({ ...this.makeSymbol(name, 'class', filePath, i, isExported, effective.split('{')[0].trim(), currentJSDoc, language), endLine })
        if (isExported) exports.push(name)
        // Extract methods inside the class
        this.extractClassMembers(lines, i, endLine, filePath, name, symbols, language)
        currentJSDoc = undefined
        continue
      }

      // Interface declarations
      const ifaceMatch = effective.match(/^interface\s+(\w+)/)
      if (ifaceMatch) {
        const name = ifaceMatch[1]
        const endLine = this.findBlockEnd(lines, i)
        symbols.push({ ...this.makeSymbol(name, 'interface', filePath, i, isExported, effective.split('{')[0].trim(), currentJSDoc, language), endLine })
        if (isExported) exports.push(name)
        currentJSDoc = undefined
        continue
      }

      // Type alias
      const typeMatch = effective.match(/^type\s+(\w+)/)
      if (typeMatch) {
        const name = typeMatch[1]
        symbols.push(this.makeSymbol(name, 'type', filePath, i, isExported, undefined, currentJSDoc, language))
        if (isExported) exports.push(name)
        currentJSDoc = undefined
        continue
      }

      // Enum
      const enumMatch = effective.match(/^(?:const\s+)?enum\s+(\w+)/)
      if (enumMatch) {
        const name = enumMatch[1]
        symbols.push(this.makeSymbol(name, 'enum', filePath, i, isExported, undefined, currentJSDoc, language))
        if (isExported) exports.push(name)
        currentJSDoc = undefined
        continue
      }

      // Variable declarations (non-function)
      const varMatch = effective.match(/^(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=/)
      if (varMatch) {
        const name = varMatch[1]
        symbols.push(this.makeSymbol(name, 'variable', filePath, i, isExported, undefined, currentJSDoc, language))
        if (isExported) exports.push(name)
        currentJSDoc = undefined
        continue
      }

      // Decorator
      const decoratorMatch = trimmed.match(/^@(\w+)/)
      if (decoratorMatch) {
        symbols.push(this.makeSymbol(decoratorMatch[1], 'decorator', filePath, i, false, undefined, undefined, language))
        continue
      }

      // Re-exports
      const reExportMatch = trimmed.match(/^export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/)
      if (reExportMatch) {
        imports.push(reExportMatch[2])
        const names = reExportMatch[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()!.trim())
        exports.push(...names)
        continue
      }

      // export * from
      const reExportAllMatch = trimmed.match(/^export\s+\*\s+from\s+['"]([^'"]+)['"]/)
      if (reExportAllMatch) {
        imports.push(reExportAllMatch[1])
        continue
      }

      // If no match, clear JSDoc
      if (trimmed.length > 0 && !trimmed.startsWith('*') && !trimmed.startsWith('//')) {
        currentJSDoc = undefined
      }
    }

    return { filePath, language, symbols, imports, exports }
  }

  private extractClassMembers(
    lines: string[], startLine: number, endLine: number,
    filePath: string, className: string, symbols: CodeSymbol[], language: string
  ): void {
    for (let i = startLine + 1; i <= endLine && i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (trimmed === '{' || trimmed === '}' || trimmed === '') continue

      // Method
      const methodMatch = trimmed.match(/^(?:(?:public|private|protected|static|async|abstract|override|readonly)\s+)*(\w+)\s*(?:<[^>]*>)?\s*\(/)
      if (methodMatch && methodMatch[1] !== 'if' && methodMatch[1] !== 'for' && methodMatch[1] !== 'while'
        && methodMatch[1] !== 'switch' && methodMatch[1] !== 'return' && methodMatch[1] !== 'new') {
        symbols.push(this.makeSymbol(methodMatch[1], 'method', filePath, i, false, undefined, undefined, language, className))
        continue
      }

      // Property
      const propMatch = trimmed.match(/^(?:(?:public|private|protected|static|readonly|abstract|override)\s+)*(\w+)\s*[?!]?\s*[:=]/)
      if (propMatch && propMatch[1] !== 'if' && propMatch[1] !== 'for' && propMatch[1] !== 'return') {
        symbols.push(this.makeSymbol(propMatch[1], 'property', filePath, i, false, undefined, undefined, language, className))
      }
    }
  }

  private makeSymbol(
    name: string, kind: SymbolKind, filePath: string, line: number,
    exported: boolean, signature?: string, documentation?: string,
    language?: string, parentName?: string
  ): CodeSymbol {
    return {
      name, kind, filePath, line,
      exported,
      ...(signature ? { signature } : {}),
      ...(documentation ? { documentation } : {}),
      ...(language ? { language } : {}),
      ...(parentName ? { parentName } : {}),
    }
  }

  private extractSignature(line: string): string {
    const parenEnd = line.indexOf(')')
    if (parenEnd === -1) return line.split('{')[0].trim()
    // Include return type
    const afterParen = line.slice(parenEnd + 1)
    const colonMatch = afterParen.match(/^\s*:\s*([^{]+)/)
    if (colonMatch) {
      return line.slice(0, parenEnd + 1) + ': ' + colonMatch[1].trim()
    }
    return line.slice(0, parenEnd + 1)
  }

  private findBlockEnd(lines: string[], startLine: number): number {
    let depth = 0
    for (let i = startLine; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') depth++
        if (ch === '}') {
          depth--
          if (depth === 0) return i
        }
      }
    }
    return Math.min(startLine + 100, lines.length - 1)
  }

  private lineOffset(lines: string[], lineIdx: number): number {
    let offset = 0
    for (let i = 0; i < lineIdx; i++) {
      offset += lines[i].length + 1
    }
    return offset
  }
}
