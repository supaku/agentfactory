'use client'

import useSWR from 'swr'
import type { PublicSessionsListResponse } from '../types/api'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

export function useSessions(refreshInterval = 5000) {
  return useSWR<PublicSessionsListResponse>('/api/public/sessions', fetcher, {
    refreshInterval,
    dedupingInterval: 2000,
  })
}
