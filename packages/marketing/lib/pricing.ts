export interface PricingPlan {
  name: string
  monthlyPrice: number
  annualPrice: number
  description: string
  features: string[]
  highlighted?: boolean
  cta: string
}

export const pricingConfig: PricingPlan = {
  name: 'Family',
  monthlyPrice: 19,
  annualPrice: 15,
  description: 'Everything you need to nurture your most important relationships.',
  features: [
    'Unlimited contacts',
    'Relationship health tracking',
    'Smart reminders & intentions',
    'Gift list management',
    'Meeting prep briefings',
    'AI-powered messaging suggestions',
    'Full data export anytime',
    'Priority support',
  ],
  highlighted: true,
  cta: 'Start your 14-day free trial',
}

export function calculateAnnualSavings(monthly: number, annual: number): number {
  return Math.round(((monthly - annual) / monthly) * 100)
}
