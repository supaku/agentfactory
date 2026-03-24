import type { EmbeddingProvider } from './embedding-provider.js'
import type { EmbeddingProviderConfig } from '../types.js'

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings'
const DEFAULT_MODEL = 'voyage-code-3'
const DEFAULT_DIMENSIONS = 256
const DEFAULT_BATCH_SIZE = 128
const DEFAULT_MAX_RETRIES = 3
const BASE_RETRY_DELAY_MS = 1000

interface VoyageAPIResponse {
  data: Array<{ embedding: number[]; index: number }>
  model: string
  usage: { total_tokens: number }
}

interface VoyageAPIError {
  detail?: string
  message?: string
}

/**
 * Embedding provider for Voyage AI's voyage-code-3 model.
 *
 * Features:
 * - 32K token context window
 * - 2048 native dimensions with Matryoshka support (256–2048)
 * - Batched requests (max 128 texts per API call)
 * - Exponential backoff retry on 429 / 5xx errors
 *
 * Requires the VOYAGE_API_KEY environment variable.
 */
export class VoyageCodeProvider implements EmbeddingProvider {
  readonly model: string
  readonly dimensions: number
  private batchSize: number
  private maxRetries: number
  private apiKey: string

  constructor(config: Partial<EmbeddingProviderConfig> = {}) {
    const apiKey = process.env.VOYAGE_API_KEY
    if (!apiKey) {
      throw new Error(
        'VOYAGE_API_KEY environment variable is required. '
        + 'Get your API key at https://dash.voyageai.com/',
      )
    }
    this.apiKey = apiKey
    this.model = config.model ?? DEFAULT_MODEL
    this.dimensions = config.dimensions ?? DEFAULT_DIMENSIONS
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
  }

  /**
   * Embed multiple texts in batches.
   * Returns one vector per input text, in the same order.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    const results: number[][] = new Array(texts.length)
    const batches = this.splitIntoBatches(texts)

    let offset = 0
    for (const batch of batches) {
      const embeddings = await this.callAPI(batch, 'document')
      for (let i = 0; i < embeddings.length; i++) {
        results[offset + i] = embeddings[i]
      }
      offset += batch.length
    }

    return results
  }

  /**
   * Embed a single query text.
   * Uses input_type "query" for asymmetric retrieval.
   */
  async embedQuery(text: string): Promise<number[]> {
    const [result] = await this.callAPI([text], 'query')
    return result
  }

  /** Split texts into batches of at most batchSize. */
  private splitIntoBatches(texts: string[]): string[][] {
    const batches: string[][] = []
    for (let i = 0; i < texts.length; i += this.batchSize) {
      batches.push(texts.slice(i, i + this.batchSize))
    }
    return batches
  }

  /** Call the Voyage embeddings API with retry logic. */
  private async callAPI(
    texts: string[],
    inputType: 'document' | 'query',
  ): Promise<number[][]> {
    const body = JSON.stringify({
      model: this.model,
      input: texts,
      input_type: inputType,
      output_dimension: this.dimensions,
    })

    let lastError: Error | undefined

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(VOYAGE_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body,
        })

        if (response.ok) {
          const json = (await response.json()) as VoyageAPIResponse
          // Sort by index to preserve input order
          const sorted = json.data.sort((a, b) => a.index - b.index)
          return sorted.map((d) => d.embedding)
        }

        // Retry on rate limit or server errors
        if (response.status === 429 || response.status >= 500) {
          const errorBody = await response.text()
          lastError = new Error(
            `Voyage API returned ${response.status}: ${errorBody}`,
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
            const parsed = JSON.parse(errorBody) as VoyageAPIError
            message = parsed.detail ?? parsed.message ?? errorBody
          } catch {
            message = errorBody
          }
          throw new Error(`Voyage API error (${response.status}): ${message}`)
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Voyage API error')) {
          throw error
        }
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt < this.maxRetries) {
          await this.sleep(BASE_RETRY_DELAY_MS * Math.pow(2, attempt))
          continue
        }
      }
    }

    throw lastError ?? new Error('Voyage API request failed after retries')
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
