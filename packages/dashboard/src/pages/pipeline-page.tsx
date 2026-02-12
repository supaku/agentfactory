'use client'

import { PipelineView } from '../components/pipeline/pipeline-view'

interface PipelinePageProps {
  onSessionSelect?: (sessionId: string) => void
}

export function PipelinePage({ onSessionSelect }: PipelinePageProps) {
  return <PipelineView onSessionSelect={onSessionSelect} />
}
