import { CodeTokenizer } from './tokenizer.js'
import type { CodeSymbol } from '../types.js'

export interface PostingEntry {
  docId: number
  termFreq: number
}

/**
 * Inverted index mapping tokens to document (symbol) IDs with term frequencies.
 */
export class InvertedIndex {
  private tokenizer = new CodeTokenizer()
  private index: Map<string, PostingEntry[]> = new Map()
  private documents: CodeSymbol[] = []
  private docLengths: number[] = []
  private avgDocLength = 0

  /** Build the index from an array of symbols. */
  build(symbols: CodeSymbol[]): void {
    this.documents = symbols
    this.index.clear()
    this.docLengths = []

    let totalLength = 0
    for (let docId = 0; docId < symbols.length; docId++) {
      const symbol = symbols[docId]
      const text = this.symbolToText(symbol)
      const tokens = this.tokenizer.tokenize(text)

      this.docLengths.push(tokens.length)
      totalLength += tokens.length

      // Count term frequencies
      const termFreqs = new Map<string, number>()
      for (const token of tokens) {
        termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1)
      }

      // Add to inverted index
      for (const [term, freq] of termFreqs) {
        if (!this.index.has(term)) {
          this.index.set(term, [])
        }
        this.index.get(term)!.push({ docId, termFreq: freq })
      }
    }

    this.avgDocLength = symbols.length > 0 ? totalLength / symbols.length : 0
  }

  /** Get posting list for a term. */
  getPostings(term: string): PostingEntry[] {
    return this.index.get(term.toLowerCase()) ?? []
  }

  /** Get document (symbol) by ID. */
  getDocument(docId: number): CodeSymbol | undefined {
    return this.documents[docId]
  }

  /** Get total number of documents. */
  getDocCount(): number {
    return this.documents.length
  }

  /** Get document length by ID. */
  getDocLength(docId: number): number {
    return this.docLengths[docId] ?? 0
  }

  /** Get average document length. */
  getAvgDocLength(): number {
    return this.avgDocLength
  }

  /** Get all unique terms. */
  getTerms(): string[] {
    return [...this.index.keys()]
  }

  private symbolToText(symbol: CodeSymbol): string {
    const parts = [symbol.name, symbol.kind]
    if (symbol.signature) parts.push(symbol.signature)
    if (symbol.documentation) parts.push(symbol.documentation)
    if (symbol.filePath) parts.push(symbol.filePath)
    return parts.join(' ')
  }
}
