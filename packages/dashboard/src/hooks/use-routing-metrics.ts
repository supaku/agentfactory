'use client'

import useSWR from 'swr'
import type { PublicRoutingMetricsResponse } from '../types/api'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

export interface UseRoutingMetricsOptions {
  from?: string
  to?: string
  limit?: number
  cursor?: string
  refreshInterval?: number
}

function buildUrl(opts: UseRoutingMetricsOptions): string {
  const params = new URLSearchParams()
  if (opts.from) params.set('from', opts.from)
  if (opts.to) params.set('to', opts.to)
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.cursor) params.set('cursor', opts.cursor)
  const qs = params.toString()
  return qs ? `/api/public/routing-metrics?${qs}` : '/api/public/routing-metrics'
}

export function useRoutingMetrics(opts: UseRoutingMetricsOptions = {}) {
  const { refreshInterval = 10000, ...queryOpts } = opts
  const url = buildUrl(queryOpts)

  return useSWR<PublicRoutingMetricsResponse>(url, fetcher, {
    refreshInterval,
    dedupingInterval: 5000,
  })
}
