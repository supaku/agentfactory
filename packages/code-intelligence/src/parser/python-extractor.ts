import type { CodeSymbol, FileAST, SymbolKind } from '../types.js'
import type { LanguageExtractor } from './symbol-extractor.js'

/** Regex-based Python symbol extractor. */
export class PythonExtractor implements LanguageExtractor {
  languages = ['python']

  extract(source: string, filePath: string): FileAST {
    const lines = source.split('\n')
    const symbols: CodeSymbol[] = []
    const imports: string[] = []
    const exports: string[] = []

    let currentDocstring: string | undefined

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()

      // Skip comments
      if (trimmed.startsWith('#')) continue

      // Docstrings (single-line)
      if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
        if (trimmed.slice(3).includes(trimmed.slice(0, 3))) {
          currentDocstring = trimmed.slice(3, trimmed.lastIndexOf(trimmed.slice(0, 3)))
        }
        continue
      }

      // Imports
      const importMatch = trimmed.match(/^(?:from\s+(\S+)\s+)?import\s+(.+)/)
      if (importMatch) {
        const module = importMatch[1] ?? importMatch[2].split(',')[0].trim().split(/\s+as\s+/)[0]
        imports.push(module)
        continue
      }

      // Decorators
      const decoratorMatch = trimmed.match(/^@(\w+)/)
      if (decoratorMatch) {
        symbols.push({
          name: decoratorMatch[1], kind: 'decorator', filePath, line: i,
          exported: false, language: 'python',
        })
        continue
      }

      // Function definitions
      const funcMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(/)
      if (funcMatch) {
        const name = funcMatch[1]
        const indent = line.length - line.trimStart().length
        const isMethod = indent > 0
        const exported = !name.startsWith('_')
        symbols.push({
          name,
          kind: isMethod ? 'method' : 'function',
          filePath, line: i,
          exported,
          signature: trimmed.split(':')[0],
          documentation: currentDocstring,
          language: 'python',
        })
        if (exported && !isMethod) exports.push(name)
        currentDocstring = undefined
        continue
      }

      // Class definitions
      const classMatch = trimmed.match(/^class\s+(\w+)/)
      if (classMatch) {
        const name = classMatch[1]
        const exported = !name.startsWith('_')
        symbols.push({
          name, kind: 'class', filePath, line: i,
          exported,
          signature: trimmed.split(':')[0],
          documentation: currentDocstring,
          language: 'python',
        })
        if (exported) exports.push(name)
        currentDocstring = undefined
        continue
      }

      // Module-level variable assignment
      const varMatch = trimmed.match(/^(\w+)\s*(?::\s*\w[^=]*)?\s*=/)
      if (varMatch && line.length - line.trimStart().length === 0) {
        const name = varMatch[1]
        const exported = !name.startsWith('_') && name === name.toUpperCase() || !name.startsWith('_')
        symbols.push({
          name, kind: 'variable', filePath, line: i,
          exported: !name.startsWith('_'),
          language: 'python',
        })
        continue
      }
    }

    return { filePath, language: 'python', symbols, imports, exports }
  }
}
