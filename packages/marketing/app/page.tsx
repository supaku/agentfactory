import Link from 'next/link'
import { Button, Badge } from '@supaku/agentfactory-dashboard'
import {
  Users,
  Heart,
  Bell,
  MessageSquare,
  Shield,
  Download,
  Lock,
  ArrowRight,
  Sparkles,
  TrendingUp,
  Gift,
  Calendar,
  Star,
  Check,
} from 'lucide-react'
import { Navbar } from '@/components/navbar'
import { Section } from '@/components/section'
import { FeatureCard } from '@/components/feature-card'
import { TestimonialCard } from '@/components/testimonial-card'
import { FaqAccordion } from './faq-accordion'
import { pricingConfig, calculateAnnualSavings } from '@/lib/pricing'

/* ------------------------------------------------------------------ */
/*  Feature showcase mock UIs                                         */
/* ------------------------------------------------------------------ */

function ContactMockUI() {
  return (
    <div className="glass-subtle rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-full bg-af-accent/20 flex items-center justify-center text-af-accent font-display text-sm font-bold">
          AK
        </div>
        <div>
          <p className="text-sm font-medium text-af-text-primary font-body">Alex Kim</p>
          <p className="text-xs text-af-text-tertiary font-body">VP Engineering at Acme Corp</p>
        </div>
      </div>
      <div className="flex gap-2 flex-wrap">
        <Badge variant="secondary" className="text-2xs">Mentor</Badge>
        <Badge variant="secondary" className="text-2xs">San Francisco</Badge>
        <Badge variant="secondary" className="text-2xs">Introduced by Sarah</Badge>
      </div>
      <div className="text-xs text-af-text-tertiary font-body flex items-center gap-1.5">
        <Calendar className="h-3 w-3" />
        Last contact: 3 days ago
      </div>
    </div>
  )
}

function HealthMockUI() {
  return (
    <div className="glass-subtle rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-body text-af-text-secondary">Relationship Score</span>
        <span className="text-2xl font-display font-bold text-af-teal">92</span>
      </div>
      <div className="h-2 rounded-full bg-af-surface-raised overflow-hidden">
        <div className="h-full rounded-full bg-af-teal" style={{ width: '92%' }} />
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="text-lg font-display font-bold text-af-text-primary">12</p>
          <p className="text-2xs text-af-text-tertiary font-body">Week Streak</p>
        </div>
        <div>
          <p className="text-lg font-display font-bold text-af-text-primary">47</p>
          <p className="text-2xs text-af-text-tertiary font-body">Interactions</p>
        </div>
        <div>
          <p className="text-lg font-display font-bold text-af-accent">
            <TrendingUp className="h-4 w-4 inline" />
          </p>
          <p className="text-2xs text-af-text-tertiary font-body">Trending Up</p>
        </div>
      </div>
    </div>
  )
}

function ReminderMockUI() {
  return (
    <div className="glass-subtle rounded-lg p-4 space-y-2">
      {[
        { icon: Gift, label: "Mom's birthday", when: 'In 3 days', color: 'text-af-accent' },
        { icon: Heart, label: 'Anniversary with Jamie', when: 'In 2 weeks', color: 'text-pink-400' },
        { icon: Users, label: 'Coffee with Alex', when: 'Tomorrow', color: 'text-af-teal' },
      ].map((item, i) => (
        <div key={i} className="flex items-center justify-between py-1.5">
          <div className="flex items-center gap-2.5">
            <item.icon className={`h-4 w-4 ${item.color}`} />
            <span className="text-sm text-af-text-primary font-body">{item.label}</span>
          </div>
          <span className="text-xs text-af-text-tertiary font-body">{item.when}</span>
        </div>
      ))}
    </div>
  )
}

function MessagingMockUI() {
  return (
    <div className="glass-subtle rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="h-4 w-4 text-af-accent" />
        <span className="text-xs text-af-text-tertiary font-body">AI Suggestion for Alex</span>
      </div>
      <div className="bg-af-surface-raised/60 rounded-lg p-3 border border-af-surface-border/30">
        <p className="text-sm text-af-text-primary font-body leading-relaxed">
          &ldquo;Hey Alex, I saw your company just closed Series B &mdash; congratulations! Would love to catch up over coffee and hear about the growth plans.&rdquo;
        </p>
      </div>
      <div className="flex gap-2">
        <Badge variant="secondary" className="text-2xs">Career milestone</Badge>
        <Badge variant="secondary" className="text-2xs">Last met 2 weeks ago</Badge>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Page Component                                                     */
/* ------------------------------------------------------------------ */

export default function LandingPage() {
  const annualSavings = calculateAnnualSavings(pricingConfig.monthlyPrice, pricingConfig.annualPrice)

  return (
    <div className="min-h-screen bg-af-bg-primary">
      <Navbar />

      {/* ---- Hero ---- */}
      <section className="relative pt-32 pb-24 px-4 sm:px-6 lg:px-8 mesh-gradient overflow-hidden">
        <div className="absolute inset-0 grid-bg opacity-30 pointer-events-none" />
        <div className="relative mx-auto max-w-4xl text-center">
          <Badge variant="secondary" className="mb-6 inline-flex gap-1.5">
            <Star className="h-3 w-3 text-af-accent" />
            Now in beta
          </Badge>
          <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl font-bold text-af-text-primary mb-6 leading-tight">
            The personal CRM that treats your relationships like they{' '}
            <span className="text-af-accent">matter</span>
          </h1>
          <p className="text-lg sm:text-xl text-af-text-secondary font-body max-w-2xl mx-auto mb-10 leading-relaxed">
            Your relationships are too important for ad-supported software. Supaku Family is the private, premium personal CRM for people who invest in their connections.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button asChild size="lg" className="glow-orange text-base px-8">
              <Link href="#pricing">
                Start your 14-day free trial
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg" className="text-base px-8">
              <Link href="/tour">Take the tour</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* ---- Features ---- */}
      <Section
        id="features"
        title="Everything you need to nurture real relationships"
        subtitle="Four powerful capabilities designed to help you be more intentional with the people who matter most."
      >
        <div className="grid gap-6 md:grid-cols-2">
          <FeatureCard
            icon={Users}
            title="Contact Management"
            description="Every detail, always up to date. Enriched profiles with smart contact cards keep your network organized without the busywork."
          >
            <ContactMockUI />
          </FeatureCard>

          <FeatureCard
            icon={Heart}
            title="Relationship Health"
            description="See your relationships at a glance. Health scores and streak tracking show you who needs attention before it is too late."
          >
            <HealthMockUI />
          </FeatureCard>

          <FeatureCard
            icon={Bell}
            title="Smart Reminders"
            description="Never miss an important moment. Birthdays, anniversaries, follow-ups, and intentions — all tracked and surfaced at the right time."
          >
            <ReminderMockUI />
          </FeatureCard>

          <FeatureCard
            icon={MessageSquare}
            title="AI Messaging"
            description="The right words at the right time. Context-aware message suggestions that sound like you, not a robot."
          >
            <MessagingMockUI />
          </FeatureCard>
        </div>
      </Section>

      {/* ---- Social Proof ---- */}
      <Section
        title="Loved by people who care"
        subtitle="Join hundreds of professionals who use Supaku Family to stay close to the people who matter."
        className="bg-af-bg-secondary/50"
      >
        <div className="grid gap-6 md:grid-cols-3">
          <TestimonialCard
            quote="I used to let months go by without reaching out to close friends. Supaku Family turned that around in weeks. The intention streaks are addictive in the best way."
            name="Priya Sharma"
            role="Staff Engineer at Stripe"
          />
          <TestimonialCard
            quote="Finally, a CRM that understands personal relationships aren't sales pipelines. The AI suggestions are surprisingly thoughtful and save me real time."
            name="Marcus Chen"
            role="Product Lead at Figma"
          />
          <TestimonialCard
            quote="The meeting prep feature alone is worth the subscription. I walk into every coffee chat feeling prepared and genuinely engaged."
            name="Emily Torres"
            role="Engineering Manager at Vercel"
          />
        </div>
      </Section>

      {/* ---- Privacy Commitment ---- */}
      <Section
        title="No ads. No data selling. No compromise."
        subtitle="Your relationships are private. We built Supaku Family with that as a non-negotiable principle."
      >
        <div className="grid gap-6 md:grid-cols-3">
          <div className="glass border border-af-surface-border rounded-xl p-6 text-center hover-glow">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-af-teal/10 text-af-teal">
              <Shield className="h-6 w-6" />
            </div>
            <h3 className="font-display text-lg font-semibold text-af-text-primary mb-2">
              Privacy by Design
            </h3>
            <p className="text-sm text-af-text-secondary font-body leading-relaxed">
              We never sell your data to advertisers. Your contact information stays yours. Our business model is simple: you pay us for great software.
            </p>
          </div>

          <div className="glass border border-af-surface-border rounded-xl p-6 text-center hover-glow">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-af-teal/10 text-af-teal">
              <Download className="h-6 w-6" />
            </div>
            <h3 className="font-display text-lg font-semibold text-af-text-primary mb-2">
              Full Data Portability
            </h3>
            <p className="text-sm text-af-text-secondary font-body leading-relaxed">
              Export all your data anytime in standard formats. No lock-in, no hidden barriers. Your data is always yours to take.
            </p>
          </div>

          <div className="glass border border-af-surface-border rounded-xl p-6 text-center hover-glow">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-af-teal/10 text-af-teal">
              <Lock className="h-6 w-6" />
            </div>
            <h3 className="font-display text-lg font-semibold text-af-text-primary mb-2">
              End-to-End Encryption
            </h3>
            <p className="text-sm text-af-text-secondary font-body leading-relaxed">
              Your personal notes and relationship data are encrypted at rest and in transit. Even we cannot read them.
            </p>
          </div>
        </div>
      </Section>

      {/* ---- Pricing ---- */}
      <Section
        id="pricing"
        title="Simple, honest pricing"
        subtitle="One plan with everything you need. No feature gates, no upsells."
        className="bg-af-bg-secondary/50"
      >
        <div className="mx-auto max-w-md">
          <div className="glass border border-af-accent/20 rounded-xl p-8 glow-orange text-center">
            <h3 className="font-display text-2xl font-bold text-af-text-primary mb-1">
              {pricingConfig.name}
            </h3>
            <div className="flex items-baseline justify-center gap-1 mb-1">
              <span className="font-display text-5xl font-bold text-af-text-primary">
                ${pricingConfig.annualPrice}
              </span>
              <span className="text-af-text-tertiary font-body">/month</span>
            </div>
            <p className="text-sm text-af-teal font-body mb-4">
              Billed annually &middot; Save {annualSavings}%
            </p>
            <p className="text-xs text-af-text-tertiary font-body mb-6">
              or ${pricingConfig.monthlyPrice}/month billed monthly
            </p>
            <p className="text-sm text-af-text-secondary font-body mb-8">
              {pricingConfig.description}
            </p>
            <ul className="text-left space-y-3 mb-8">
              {pricingConfig.features.map((feature) => (
                <li key={feature} className="flex items-start gap-2.5 text-sm text-af-text-secondary font-body">
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
              No credit card required. Cancel anytime.
            </p>
          </div>
        </div>
      </Section>

      {/* ---- FAQ ---- */}
      <Section
        title="Frequently asked questions"
        subtitle="Everything you need to know about Supaku Family."
      >
        <div className="mx-auto max-w-2xl">
          <FaqAccordion />
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
            <Link href="/#features" className="text-sm text-af-text-secondary hover:text-af-text-primary transition-colors font-body">
              Features
            </Link>
            <Link href="/tour" className="text-sm text-af-text-secondary hover:text-af-text-primary transition-colors font-body">
              Tour
            </Link>
            <Link href="/#pricing" className="text-sm text-af-text-secondary hover:text-af-text-primary transition-colors font-body">
              Pricing
            </Link>
            <Link href="#" className="text-sm text-af-text-secondary hover:text-af-text-primary transition-colors font-body">
              Privacy
            </Link>
            <Link href="#" className="text-sm text-af-text-secondary hover:text-af-text-primary transition-colors font-body">
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
