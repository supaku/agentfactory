'use client'

import { useState } from 'react'
import { PipelineView } from '../components/pipeline/pipeline-view'
import { DeprecationBanner } from '../components/pipeline/deprecation-banner'

export interface PipelinePageProps {
  onSessionSelect?: (sessionId: string) => void
  /** When true, disables all interactive elements (drag, edit, status changes) */
  readOnly?: boolean
  /** When true, shows a deprecation banner */
  deprecated?: boolean
  /** Custom deprecation message */
  deprecationMessage?: string
  /** CTA link in the deprecation banner */
  deprecationCtaHref?: string
}

export function PipelinePage({
  onSessionSelect,
  readOnly,
  deprecated,
  deprecationMessage,
  deprecationCtaHref,
}: PipelinePageProps) {
  const [bannerDismissed, setBannerDismissed] = useState(false)

  return (
    <div>
      {deprecated && !bannerDismissed && (
        <DeprecationBanner
          message={deprecationMessage}
          ctaHref={deprecationCtaHref}
          onDismiss={() => setBannerDismissed(true)}
        />
      )}
      <PipelineView
        onSessionSelect={readOnly ? undefined : onSessionSelect}
        readOnly={readOnly}
      />
    </div>
  )
}
