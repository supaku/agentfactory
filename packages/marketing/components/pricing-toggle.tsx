'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Button, cn } from '@supaku/agentfactory-dashboard'
import { ArrowRight, Check } from 'lucide-react'
import { pricingConfig, calculateAnnualSavings } from '@/lib/pricing'

export function PricingToggle() {
  const [isAnnual, setIsAnnual] = useState(true)
  const annualSavings = calculateAnnualSavings(pricingConfig.monthlyPrice, pricingConfig.annualPrice)

  const currentPrice = isAnnual ? pricingConfig.annualPrice : pricingConfig.monthlyPrice
  const annualTotal = pricingConfig.annualPrice * 12

  return (
    <div className="mx-auto max-w-md">
      {/* Toggle */}
      <div className="flex items-center justify-center gap-3 mb-8">
        <span
          className={cn(
            'text-sm font-body transition-colors duration-200 cursor-pointer',
            !isAnnual ? 'text-af-text-primary font-medium' : 'text-af-text-tertiary'
          )}
          onClick={() => setIsAnnual(false)}
        >
          Monthly
        </span>
        <button
          onClick={() => setIsAnnual(!isAnnual)}
          className={cn(
            'relative inline-flex h-7 w-12 items-center rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/50',
            isAnnual ? 'bg-af-accent' : 'bg-af-surface-border'
          )}
          role="switch"
          aria-checked={isAnnual}
          aria-label="Toggle annual billing"
        >
          <span
            className={cn(
              'inline-block h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200',
              isAnnual ? 'translate-x-6' : 'translate-x-1'
            )}
          />
        </button>
        <span
          className={cn(
            'text-sm font-body transition-colors duration-200 cursor-pointer',
            isAnnual ? 'text-af-text-primary font-medium' : 'text-af-text-tertiary'
          )}
          onClick={() => setIsAnnual(true)}
        >
          Annual
        </span>
        {isAnnual && (
          <span className="inline-flex items-center rounded-full bg-af-teal/10 text-af-teal px-2.5 py-0.5 text-xs font-medium font-body">
            Save {annualSavings}%
          </span>
        )}
      </div>

      {/* Pricing Card */}
      <div className="glass border border-af-accent/20 rounded-xl p-8 glow-orange text-center">
        <h3 className="font-display text-2xl font-bold text-af-text-primary mb-1">
          {pricingConfig.name}
        </h3>
        <div className="flex items-baseline justify-center gap-1 mb-1">
          <span className="font-display text-5xl font-bold text-af-text-primary">
            ${currentPrice}
          </span>
          <span className="text-af-text-tertiary font-body">/month</span>
        </div>
        {isAnnual ? (
          <p className="text-sm text-af-teal font-body mb-6">
            Billed annually at ${annualTotal}/year
          </p>
        ) : (
          <p className="text-sm text-af-text-tertiary font-body mb-6">
            Billed monthly
          </p>
        )}
        <p className="text-sm text-af-text-secondary font-body mb-8">
          {pricingConfig.description}
        </p>
        <ul className="text-left space-y-3 mb-8">
          {pricingConfig.features.map((feature) => (
            <li
              key={feature}
              className="flex items-start gap-2.5 text-sm text-af-text-secondary font-body"
            >
              <Check className="h-4 w-4 text-af-teal shrink-0 mt-0.5" />
              {feature}
            </li>
          ))}
        </ul>
        <Button asChild size="lg" className="w-full glow-orange text-base">
          <Link href="#">
            {pricingConfig.cta}
            <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
        <p className="text-xs text-af-text-tertiary font-body mt-3">
          No credit card required
        </p>
      </div>
    </div>
  )
}
