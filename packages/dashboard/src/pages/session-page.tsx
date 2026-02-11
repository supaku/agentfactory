'use client'

import { useState } from 'react'
import { useSessions } from '../hooks/use-sessions'
import { SessionList } from '../components/sessions/session-list'
import { SessionDetail } from '../components/sessions/session-detail'

interface SessionPageProps {
  sessionId?: string
}

export function SessionPage({ sessionId: initialId }: SessionPageProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>(initialId)
  const { data } = useSessions()
  const sessions = data?.sessions ?? []

  const selected = selectedId ? sessions.find((s) => s.id === selectedId) : undefined

  if (selected) {
    return (
      <SessionDetail
        session={selected}
        onBack={() => setSelectedId(undefined)}
      />
    )
  }

  return <SessionList onSelect={setSelectedId} />
}
