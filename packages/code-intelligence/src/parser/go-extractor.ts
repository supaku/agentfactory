import type { CodeSymbol, FileAST, SymbolKind } from '../types.js'
import type { LanguageExtractor } from './symbol-extractor.js'

/** Regex-based Go symbol extractor. */
export class GoExtractor implements LanguageExtractor {
  languages = ['go']

  extract(source: string, filePath: string): FileAST {
    const lines = source.split('\n')
    const symbols: CodeSymbol[] = []
    const imports: string[] = []
    const exports: string[] = []

    let currentComment: string | undefined

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()

      // Skip comments, but track for documentation
      if (trimmed.startsWith('//')) {
        currentComment = (currentComment ? currentComment + '\n' : '') + trimmed.slice(2).trim()
        continue
      }

      // Imports
      const importMatch = trimmed.match(/^import\s+"([^"]+)"/)
      if (importMatch) {
        imports.push(importMatch[1])
        continue
      }
      // Multi-line import
      if (trimmed === 'import (') {
        for (let j = i + 1; j < lines.length; j++) {
          const importLine = lines[j].trim()
          if (importLine === ')') break
          const pkg = importLine.match(/"([^"]+)"/)
          if (pkg) imports.push(pkg[1])
        }
        continue
      }

      // Function declarations (with optional receiver)
      const funcMatch = trimmed.match(/^func\s+(?:\((\w+)\s+\*?(\w+)\)\s+)?(\w+)\s*\(/)
      if (funcMatch) {
        const receiverVar = funcMatch[1]
        const receiverType = funcMatch[2]
        const name = funcMatch[3]
        const isExported = name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase()

        symbols.push({
          name,
          kind: receiverType ? 'method' : 'function',
          filePath, line: i,
          exported: isExported,
          signature: trimmed.split('{')[0].trim(),
          documentation: currentComment,
          language: 'go',
          ...(receiverType ? { parentName: receiverType } : {}),
        })
        if (isExported) exports.push(name)
        currentComment = undefined
        continue
      }

      // Struct declaration
      const structMatch = trimmed.match(/^type\s+(\w+)\s+struct\b/)
      if (structMatch) {
        const name = structMatch[1]
        const isExported = name[0] === name[0].toUpperCase()
        symbols.push({
          name, kind: 'struct', filePath, line: i,
          exported: isExported,
          documentation: currentComment,
          language: 'go',
        })
        if (isExported) exports.push(name)
        currentComment = undefined
        continue
      }

      // Interface declaration
      const ifaceMatch = trimmed.match(/^type\s+(\w+)\s+interface\b/)
      if (ifaceMatch) {
        const name = ifaceMatch[1]
        const isExported = name[0] === name[0].toUpperCase()
        symbols.push({
          name, kind: 'interface', filePath, line: i,
          exported: isExported,
          documentation: currentComment,
          language: 'go',
        })
        if (isExported) exports.push(name)
        currentComment = undefined
        continue
      }

      // Type alias
      const typeMatch = trimmed.match(/^type\s+(\w+)\s+(?!struct|interface)/)
      if (typeMatch) {
        const name = typeMatch[1]
        const isExported = name[0] === name[0].toUpperCase()
        symbols.push({
          name, kind: 'type', filePath, line: i,
          exported: isExported,
          language: 'go',
        })
        if (isExported) exports.push(name)
        currentComment = undefined
        continue
      }

      // Variable/constant
      const varMatch = trimmed.match(/^(?:var|const)\s+(\w+)/)
      if (varMatch) {
        const name = varMatch[1]
        const isExported = name[0] === name[0].toUpperCase()
        symbols.push({
          name, kind: 'variable', filePath, line: i,
          exported: isExported,
          language: 'go',
        })
        if (isExported) exports.push(name)
        currentComment = undefined
        continue
      }

      // Clear comment if line is not empty and not a comment
      if (trimmed.length > 0) {
        currentComment = undefined
      }
    }

    return { filePath, language: 'go', symbols, imports, exports }
  }
}
