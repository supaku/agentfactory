import type { FileAST, CodeSymbol, EmbeddingChunk } from '../types.js'

export interface ChunkerOptions {
  /** Maximum number of lines per chunk before sliding window kicks in. Default: 200 */
  maxChunkLines?: number
  /** Overlap lines between sliding window chunks. Default: 20 */
  overlapLines?: number
}

const DEFAULT_MAX_CHUNK_LINES = 200
const DEFAULT_OVERLAP_LINES = 20

/**
 * Converts FileAST / CodeSymbol data into embedding-ready chunks.
 *
 * Each chunk contains a symbol's signature, documentation, and body.
 * Large symbols exceeding maxChunkLines are split using a sliding window with overlap.
 */
export class Chunker {
  private maxChunkLines: number
  private overlapLines: number

  constructor(options: ChunkerOptions = {}) {
    this.maxChunkLines = options.maxChunkLines ?? DEFAULT_MAX_CHUNK_LINES
    this.overlapLines = options.overlapLines ?? DEFAULT_OVERLAP_LINES
  }

  /**
   * Convert a FileAST into embedding chunks.
   * Each symbol with line/endLine info becomes one or more chunks.
   * Symbols without endLine are treated as single-line.
   */
  chunkFile(ast: FileAST, fileContent?: string): EmbeddingChunk[] {
    const chunks: EmbeddingChunk[] = []
    const lines = fileContent ? fileContent.split('\n') : undefined

    for (const symbol of ast.symbols) {
      const symbolChunks = this.chunkSymbol(symbol, ast.language, lines)
      chunks.push(...symbolChunks)
    }

    return chunks
  }

  /**
   * Convert multiple FileASTs into chunks.
   * Optionally accepts a map of filePath -> fileContent for body extraction.
   */
  chunkFiles(
    asts: FileAST[],
    fileContents?: Map<string, string>,
  ): EmbeddingChunk[] {
    const chunks: EmbeddingChunk[] = []
    for (const ast of asts) {
      const content = fileContents?.get(ast.filePath)
      chunks.push(...this.chunkFile(ast, content))
    }
    return chunks
  }

  /** Convert a single CodeSymbol into one or more chunks. */
  private chunkSymbol(
    symbol: CodeSymbol,
    language: string,
    lines?: string[],
  ): EmbeddingChunk[] {
    const startLine = symbol.line
    const endLine = symbol.endLine ?? symbol.line

    // Build the text content for this symbol
    const body = this.extractBody(symbol, lines, startLine, endLine)
    const fullContent = this.buildChunkContent(symbol, body)
    const totalLines = endLine - startLine + 1

    // If the symbol fits within maxChunkLines, produce a single chunk
    if (totalLines <= this.maxChunkLines) {
      return [this.makeChunk(symbol, language, fullContent, startLine, endLine)]
    }

    // Sliding window for large symbols
    return this.slidingWindowChunks(symbol, language, lines, startLine, endLine)
  }

  /** Extract the body text of a symbol from source lines. */
  private extractBody(
    symbol: CodeSymbol,
    lines: string[] | undefined,
    startLine: number,
    endLine: number,
  ): string {
    if (!lines) return ''
    // Lines are 0-indexed in the array, symbol lines are 0-indexed
    const start = Math.max(0, startLine)
    const end = Math.min(lines.length - 1, endLine)
    return lines.slice(start, end + 1).join('\n')
  }

  /** Build the full text content for a chunk from symbol metadata + body. */
  private buildChunkContent(symbol: CodeSymbol, body: string): string {
    const parts: string[] = []

    if (symbol.signature) {
      parts.push(symbol.signature)
    }

    if (symbol.documentation) {
      parts.push(symbol.documentation)
    }

    if (body) {
      parts.push(body)
    }

    // If we have no body and no signature, use just the name
    if (parts.length === 0) {
      parts.push(`${symbol.kind} ${symbol.name}`)
    }

    return parts.join('\n\n')
  }

  /** Split a large symbol into overlapping window chunks. */
  private slidingWindowChunks(
    symbol: CodeSymbol,
    language: string,
    lines: string[] | undefined,
    startLine: number,
    endLine: number,
  ): EmbeddingChunk[] {
    const chunks: EmbeddingChunk[] = []
    const step = this.maxChunkLines - this.overlapLines

    let windowStart = startLine
    let windowIndex = 0

    while (windowStart <= endLine) {
      const windowEnd = Math.min(windowStart + this.maxChunkLines - 1, endLine)
      const body = lines
        ? lines.slice(
          Math.max(0, windowStart),
          Math.min(lines.length, windowEnd + 1),
        ).join('\n')
        : ''

      // Prepend signature/docs to the first window only
      let content: string
      if (windowIndex === 0) {
        const preamble: string[] = []
        if (symbol.signature) preamble.push(symbol.signature)
        if (symbol.documentation) preamble.push(symbol.documentation)
        content = preamble.length > 0
          ? preamble.join('\n\n') + '\n\n' + body
          : body
      } else {
        content = body
      }

      chunks.push(this.makeChunk(
        symbol,
        language,
        content,
        windowStart,
        windowEnd,
        windowIndex,
      ))

      windowStart += step
      windowIndex++
    }

    return chunks
  }

  /** Create an EmbeddingChunk with a deterministic ID. */
  private makeChunk(
    symbol: CodeSymbol,
    language: string,
    content: string,
    startLine: number,
    endLine: number,
    windowIndex?: number,
  ): EmbeddingChunk {
    const idParts = [symbol.filePath, symbol.name, String(startLine)]
    if (windowIndex !== undefined && windowIndex > 0) {
      idParts.push(String(windowIndex))
    }

    return {
      id: idParts.join(':'),
      content,
      metadata: {
        filePath: symbol.filePath,
        symbolName: symbol.name,
        symbolKind: symbol.kind,
        startLine,
        endLine,
        language,
      },
    }
  }
}
