'use client'

import useSWR from 'swr'
import type { PublicRoutingMetricsResponse } from '../types/api'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

export function useRoutingMetrics(refreshInterval = 10000) {
  return useSWR<PublicRoutingMetricsResponse>('/api/public/routing-metrics', fetcher, {
    refreshInterval,
    dedupingInterval: 5000,
  })
}
