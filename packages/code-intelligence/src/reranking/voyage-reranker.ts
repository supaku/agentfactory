/**
 * Cross-encoder reranker using the Voyage AI Rerank API.
 *
 * Features:
 * - Model: rerank-2
 * - Exponential backoff retry on 429 / 5xx errors
 * - Uses Node.js built-in fetch
 * - Shares VOYAGE_API_KEY with the Voyage embedding provider
 *
 * Requires the VOYAGE_API_KEY environment variable.
 */

import type { RerankerProvider, RerankDocument, RerankResult } from './reranker-provider.js'

const VOYAGE_RERANK_URL = 'https://api.voyageai.com/v1/rerank'
const DEFAULT_MODEL = 'rerank-2'
const DEFAULT_MAX_RETRIES = 3
const BASE_RETRY_DELAY_MS = 1000

interface VoyageRerankResponse {
  data: Array<{
    index: number
    relevance_score: number
  }>
}

export class VoyageReranker implements RerankerProvider {
  readonly model: string
  private maxRetries: number
  private apiKey: string

  constructor(config: { model?: string; maxRetries?: number } = {}) {
    const apiKey = process.env.VOYAGE_API_KEY
    if (!apiKey) {
      throw new Error(
        'VOYAGE_API_KEY environment variable is required. '
        + 'Get your API key at https://dash.voyageai.com/',
      )
    }
    this.apiKey = apiKey
    this.model = config.model ?? DEFAULT_MODEL
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
  }

  async rerank(query: string, documents: RerankDocument[]): Promise<RerankResult[]> {
    if (documents.length === 0) return []

    const body = JSON.stringify({
      model: this.model,
      query,
      documents: documents.map(d => d.text),
      top_k: documents.length,
    })

    const response = await this.callAPI(body)

    return response.data.map(r => ({
      id: documents[r.index].id,
      score: r.relevance_score,
      index: r.index,
    }))
  }

  private async callAPI(body: string): Promise<VoyageRerankResponse> {
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(VOYAGE_RERANK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body,
        })

        if (response.ok) {
          return (await response.json()) as VoyageRerankResponse
        }

        // Retry on rate limit or server errors
        if (response.status === 429 || response.status >= 500) {
          const errorBody = await response.text()
          lastError = new Error(
            `Voyage Rerank API returned ${response.status}: ${errorBody}`,
          )
          if (attempt < this.maxRetries) {
            await this.sleep(this.getRetryDelay(attempt, response))
            continue
          }
        } else {
          // Non-retryable error
          const errorBody = await response.text()
          let message: string
          try {
            const parsed = JSON.parse(errorBody) as { detail?: string; message?: string }
            message = parsed.detail ?? parsed.message ?? errorBody
          } catch {
            message = errorBody
          }
          throw new Error(`Voyage Rerank API error (${response.status}): ${message}`)
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Voyage Rerank API error')) {
          throw error
        }
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt < this.maxRetries) {
          await this.sleep(BASE_RETRY_DELAY_MS * Math.pow(2, attempt))
          continue
        }
      }
    }

    throw lastError ?? new Error('Voyage Rerank API request failed after retries')
  }

  /** Calculate retry delay with exponential backoff, respecting Retry-After header. */
  private getRetryDelay(attempt: number, response: Response): number {
    const retryAfter = response.headers.get('retry-after')
    if (retryAfter) {
      const seconds = Number(retryAfter)
      if (!Number.isNaN(seconds)) {
        return seconds * 1000
      }
    }
    return BASE_RETRY_DELAY_MS * Math.pow(2, attempt)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
