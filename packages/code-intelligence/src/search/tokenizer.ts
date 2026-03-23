/**
 * Code-aware tokenizer that splits on camelCase, snake_case, kebab-case.
 * Preserves compound tokens while also indexing sub-tokens.
 */
export class CodeTokenizer {
  /** Tokenize a code identifier or query string. */
  tokenize(text: string): string[] {
    const tokens: string[] = []

    // Split on whitespace and common delimiters, but preserve _ and - for compound tokens
    const words = text.split(/[\s.,:;()\[\]{}<>=!&|+*/\\@#$%^~`'"]+/)
      .filter(w => w.length > 0)

    for (const word of words) {
      // Add the full word as a token (lowered)
      const lower = word.toLowerCase()
      tokens.push(lower)

      // Split camelCase / PascalCase
      const camelParts = this.splitCamelCase(word)
      if (camelParts.length > 1) {
        for (const part of camelParts) {
          const p = part.toLowerCase()
          if (p.length >= 2 && p !== lower) {
            tokens.push(p)
          }
        }
      }

      // Split snake_case / kebab-case
      const snakeParts = word.split(/[_-]/).filter(p => p.length > 0)
      if (snakeParts.length > 1) {
        for (const part of snakeParts) {
          const p = part.toLowerCase()
          if (p.length >= 2 && !tokens.includes(p)) {
            tokens.push(p)
          }
        }
      }
    }

    return tokens
  }

  /** Split camelCase/PascalCase into parts. */
  private splitCamelCase(word: string): string[] {
    // Insert boundary before uppercase letters
    return word
      .replace(/([a-z])([A-Z])/g, '$1\0$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1\0$2')
      .split('\0')
      .filter(p => p.length > 0)
  }
}
