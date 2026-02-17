import Link from 'next/link'
import { Button } from '@supaku/agentfactory-dashboard'
import { ArrowRight, Sparkles } from 'lucide-react'
import { Navbar } from '@/components/navbar'
import { Section } from '@/components/section'
import { FaqItem } from '@/components/faq-item'
import { PricingToggle } from '@/components/pricing-toggle'
import { ComparisonTable } from '@/components/comparison-table'

const pricingFaqs = [
  {
    question: 'Why no free tier?',
    answer:
      'We believe your relationships deserve a product built on a sustainable business model. Free tiers lead to ad-supported software that sells your data. We charge a fair price so we never have to compromise on your privacy.',
  },
  {
    question: 'Can I export my data?',
    answer:
      'Absolutely. You own your data, always. Export everything \u2014 contacts, notes, reminders, relationship history \u2014 at any time in standard formats (CSV, JSON). No lock-in, ever.',
  },
  {
    question: 'What happens if I cancel?',
    answer:
      'Your data remains accessible for 30 days after cancellation. You can export everything during that period. After 30 days, your data is permanently and securely deleted.',
  },
  {
    question: 'Is there a family or team plan?',
    answer:
      'Not yet, but it\u2019s on our roadmap. Currently, Supaku Family is designed for individual use. Join our waitlist for updates on multi-user plans.',
  },
  {
    question: 'Can I get a refund?',
    answer:
      'Yes. If you\u2019re not satisfied within the first 30 days, we\u2019ll refund you in full \u2014 no questions asked.',
  },
  {
    question: 'Do you offer student or non-profit discounts?',
    answer:
      'Yes! Email us at hello@supaku.com with verification and we\u2019ll set up a 50% discount on your subscription.',
  },
]

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-af-bg-primary">
      <Navbar />

      {/* ---- Header ---- */}
      <section className="relative pt-32 pb-16 px-4 sm:px-6 lg:px-8 mesh-gradient overflow-hidden">
        <div className="absolute inset-0 grid-bg opacity-20 pointer-events-none" />
        <div className="relative mx-auto max-w-3xl text-center">
          <h1 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold text-af-text-primary mb-6 leading-tight">
            Simple, honest pricing
          </h1>
          <p className="text-lg text-af-text-secondary font-body max-w-xl mx-auto leading-relaxed">
            One plan, everything included. No hidden fees, no feature gating.
          </p>
        </div>
      </section>

      {/* ---- Pricing Card with Toggle ---- */}
      <Section>
        <PricingToggle />
      </Section>

      {/* ---- Feature Comparison ---- */}
      <Section
        title="Why choose Supaku Family?"
        subtitle="See how we compare to the tools you might be using today."
        className="bg-af-bg-secondary/50"
      >
        <ComparisonTable />
      </Section>

      {/* ---- FAQ ---- */}
      <Section
        title="Frequently asked questions"
        subtitle="Everything you need to know about pricing and billing."
      >
        <div className="mx-auto max-w-2xl">
          {pricingFaqs.map((faq, i) => (
            <FaqItem
              key={faq.question}
              question={faq.question}
              answer={faq.answer}
              defaultOpen={i === 0}
            />
          ))}
        </div>
      </Section>

      {/* ---- Bottom CTA ---- */}
      <Section className="bg-af-bg-secondary/50">
        <div className="text-center">
          <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-af-accent/10 text-af-accent mb-6">
            <Sparkles className="h-6 w-6" />
          </div>
          <h2 className="font-display text-3xl sm:text-4xl font-bold text-af-text-primary mb-4">
            Ready to invest in your relationships?
          </h2>
          <p className="text-lg text-af-text-secondary font-body max-w-xl mx-auto mb-8">
            Join professionals who believe relationships are worth more than $19/month.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button asChild size="lg" className="glow-orange text-base px-8">
              <Link href="#">
                Start your 14-day free trial
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg" className="text-base px-8">
              <Link href="/tour">Take the tour</Link>
            </Button>
          </div>
        </div>
      </Section>

      {/* ---- Footer ---- */}
      <footer className="border-t border-af-surface-border/50 py-12 px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl flex flex-col sm:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2">
            <span className="font-display text-lg font-bold text-af-text-primary">
              Supaku <span className="text-af-accent">Family</span>
            </span>
          </div>
          <nav className="flex flex-wrap items-center gap-6">
            <Link
              href="/#features"
              className="text-sm text-af-text-secondary hover:text-af-text-primary transition-colors font-body"
            >
              Features
            </Link>
            <Link
              href="/tour"
              className="text-sm text-af-text-secondary hover:text-af-text-primary transition-colors font-body"
            >
              Tour
            </Link>
            <Link
              href="/#pricing"
              className="text-sm text-af-text-secondary hover:text-af-text-primary transition-colors font-body"
            >
              Pricing
            </Link>
            <Link
              href="#"
              className="text-sm text-af-text-secondary hover:text-af-text-primary transition-colors font-body"
            >
              Privacy
            </Link>
            <Link
              href="#"
              className="text-sm text-af-text-secondary hover:text-af-text-primary transition-colors font-body"
            >
              Blog
            </Link>
          </nav>
          <p className="text-xs text-af-text-tertiary font-body">
            &copy; {new Date().getFullYear()} Supaku. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  )
}
