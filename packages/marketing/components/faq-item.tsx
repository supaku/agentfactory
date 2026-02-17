'use client'

import { useState } from 'react'
import { cn } from '@supaku/agentfactory-dashboard'
import { ChevronDown } from 'lucide-react'

interface FaqItemProps {
  question: string
  answer: string
  defaultOpen?: boolean
}

export function FaqItem({ question, answer, defaultOpen = false }: FaqItemProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="border-b border-af-surface-border/50">
      <button
        className="flex w-full items-center justify-between py-5 text-left group"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="font-display text-base font-medium text-af-text-primary group-hover:text-af-accent transition-colors pr-4">
          {question}
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-af-text-tertiary transition-transform duration-200',
            open && 'rotate-180'
          )}
        />
      </button>
      <div
        className={cn(
          'overflow-hidden transition-all duration-300 ease-in-out',
          open ? 'max-h-96 opacity-100 pb-5' : 'max-h-0 opacity-0'
        )}
      >
        <p className="text-sm text-af-text-secondary font-body leading-relaxed pr-8">
          {answer}
        </p>
      </div>
    </div>
  )
}
