'use client'

import useSWR from 'swr'
import type { WorkersListResponse } from '../types/api'

const authedFetcher = async (url: string) => {
  const res = await fetch(url)
  if (res.status === 401) return null
  return res.json()
}

export function useWorkers(refreshInterval = 10000) {
  return useSWR<WorkersListResponse | null>('/api/workers', authedFetcher, {
    refreshInterval,
    dedupingInterval: 5000,
  })
}
