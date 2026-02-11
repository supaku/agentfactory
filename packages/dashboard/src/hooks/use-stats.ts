'use client'

import useSWR from 'swr'
import type { PublicStatsResponse } from '../types/api'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

export function useStats(refreshInterval = 5000) {
  return useSWR<PublicStatsResponse>('/api/public/stats', fetcher, {
    refreshInterval,
    dedupingInterval: 2000,
  })
}
