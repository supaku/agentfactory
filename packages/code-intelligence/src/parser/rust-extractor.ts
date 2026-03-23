import type { CodeSymbol, FileAST, SymbolKind } from '../types.js'
import type { LanguageExtractor } from './symbol-extractor.js'

/** Regex-based Rust symbol extractor. */
export class RustExtractor implements LanguageExtractor {
  languages = ['rust']

  extract(source: string, filePath: string): FileAST {
    const lines = source.split('\n')
    const symbols: CodeSymbol[] = []
    const imports: string[] = []
    const exports: string[] = []

    let currentDoc: string | undefined

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()

      // Doc comments
      if (trimmed.startsWith('///')) {
        currentDoc = (currentDoc ? currentDoc + '\n' : '') + trimmed.slice(3).trim()
        continue
      }

      // Regular comments
      if (trimmed.startsWith('//')) continue

      // Use statements (imports)
      const useMatch = trimmed.match(/^(?:pub\s+)?use\s+(.+);/)
      if (useMatch) {
        imports.push(useMatch[1])
        continue
      }

      const isPublic = trimmed.startsWith('pub ')
      const effective = isPublic ? trimmed.replace(/^pub\s+(?:\(crate\)\s+)?/, '') : trimmed

      // Function declarations
      const fnMatch = effective.match(/^(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/)
      if (fnMatch) {
        const name = fnMatch[1]
        symbols.push({
          name, kind: 'function', filePath, line: i,
          exported: isPublic,
          signature: effective.split('{')[0].trim(),
          documentation: currentDoc,
          language: 'rust',
        })
        if (isPublic) exports.push(name)
        currentDoc = undefined
        continue
      }

      // Struct declarations
      const structMatch = effective.match(/^struct\s+(\w+)/)
      if (structMatch) {
        const name = structMatch[1]
        symbols.push({
          name, kind: 'struct', filePath, line: i,
          exported: isPublic,
          documentation: currentDoc,
          language: 'rust',
        })
        if (isPublic) exports.push(name)
        currentDoc = undefined
        continue
      }

      // Enum declarations
      const enumMatch = effective.match(/^enum\s+(\w+)/)
      if (enumMatch) {
        const name = enumMatch[1]
        symbols.push({
          name, kind: 'enum', filePath, line: i,
          exported: isPublic,
          documentation: currentDoc,
          language: 'rust',
        })
        if (isPublic) exports.push(name)
        currentDoc = undefined
        continue
      }

      // Trait declarations
      const traitMatch = effective.match(/^trait\s+(\w+)/)
      if (traitMatch) {
        const name = traitMatch[1]
        symbols.push({
          name, kind: 'trait', filePath, line: i,
          exported: isPublic,
          documentation: currentDoc,
          language: 'rust',
        })
        if (isPublic) exports.push(name)
        currentDoc = undefined
        continue
      }

      // Impl blocks
      const implMatch = effective.match(/^impl(?:<[^>]+>)?\s+(?:(\w+)\s+for\s+)?(\w+)/)
      if (implMatch) {
        const traitName = implMatch[1]
        const typeName = implMatch[2]
        const name = traitName ? `${traitName} for ${typeName}` : typeName
        symbols.push({
          name, kind: 'impl', filePath, line: i,
          exported: false,
          documentation: currentDoc,
          language: 'rust',
        })
        currentDoc = undefined
        continue
      }

      // Macro definitions
      const macroMatch = effective.match(/^macro_rules!\s+(\w+)/)
      if (macroMatch) {
        const name = macroMatch[1]
        symbols.push({
          name, kind: 'macro', filePath, line: i,
          exported: isPublic,
          documentation: currentDoc,
          language: 'rust',
        })
        if (isPublic) exports.push(name)
        currentDoc = undefined
        continue
      }

      // Const/static
      const constMatch = effective.match(/^(?:const|static)\s+(\w+)/)
      if (constMatch) {
        const name = constMatch[1]
        symbols.push({
          name, kind: 'variable', filePath, line: i,
          exported: isPublic,
          language: 'rust',
        })
        if (isPublic) exports.push(name)
        currentDoc = undefined
        continue
      }

      // Type alias
      const typeMatch = effective.match(/^type\s+(\w+)/)
      if (typeMatch) {
        const name = typeMatch[1]
        symbols.push({
          name, kind: 'type', filePath, line: i,
          exported: isPublic,
          language: 'rust',
        })
        if (isPublic) exports.push(name)
        currentDoc = undefined
        continue
      }

      // Module declarations
      const modMatch = effective.match(/^mod\s+(\w+)/)
      if (modMatch) {
        const name = modMatch[1]
        symbols.push({
          name, kind: 'module', filePath, line: i,
          exported: isPublic,
          language: 'rust',
        })
        if (isPublic) exports.push(name)
        currentDoc = undefined
        continue
      }

      if (trimmed.length > 0 && !trimmed.startsWith('*')) {
        currentDoc = undefined
      }
    }

    return { filePath, language: 'rust', symbols, imports, exports }
  }
}
