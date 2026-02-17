import Link from 'next/link'
import { Button, Badge } from '@supaku/agentfactory-dashboard'
import {
  Users,
  Target,
  Gift,
  FileText,
  ArrowRight,
  MapPin,
  Briefcase,
  Calendar,
  Heart,
  Phone,
  Coffee,
  TrendingUp,
  Star,
  Clock,
  MessageSquare,
  Flame,
  DollarSign,
  Sparkles,
} from 'lucide-react'
import { Navbar } from '@/components/navbar'
import { Section } from '@/components/section'
import { TourStep } from '@/components/tour-step'

/* ------------------------------------------------------------------ */
/*  Demo mock UIs for each tour step                                   */
/* ------------------------------------------------------------------ */

function ContactViewDemo() {
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="h-14 w-14 rounded-full bg-gradient-to-br from-af-accent/30 to-af-teal/20 flex items-center justify-center text-af-accent font-display text-lg font-bold shrink-0">
          SC
        </div>
        <div className="min-w-0">
          <h4 className="font-display text-lg font-bold text-af-text-primary">Sarah Chen</h4>
          <div className="flex items-center gap-1.5 text-sm text-af-text-secondary font-body">
            <Briefcase className="h-3.5 w-3.5" />
            <span>CTO at Notion</span>
          </div>
          <div className="flex items-center gap-1.5 text-sm text-af-text-tertiary font-body mt-0.5">
            <MapPin className="h-3.5 w-3.5" />
            <span>San Francisco, CA</span>
          </div>
        </div>
      </div>

      {/* Tags */}
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="secondary" className="text-2xs">Close Friend</Badge>
        <Badge variant="secondary" className="text-2xs">Tech</Badge>
        <Badge variant="secondary" className="text-2xs">Met at React Conf</Badge>
        <Badge variant="secondary" className="text-2xs">Mentor</Badge>
      </div>

      {/* Relationship Health */}
      <div className="glass-subtle rounded-lg p-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Heart className="h-4 w-4 text-af-teal" />
          <span className="text-sm font-body text-af-text-secondary">Relationship Health</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-2 w-20 rounded-full bg-af-surface-raised overflow-hidden">
            <div className="h-full rounded-full bg-af-teal" style={{ width: '88%' }} />
          </div>
          <span className="text-sm font-display font-bold text-af-teal">88</span>
        </div>
      </div>

      {/* Recent interactions */}
      <div className="space-y-2">
        <p className="text-xs text-af-text-tertiary font-body uppercase tracking-wider">Recent Interactions</p>
        <div className="space-y-1.5">
          {[
            { icon: Coffee, label: 'Coffee at Blue Bottle', when: '3 days ago' },
            { icon: Phone, label: 'Phone call (32 min)', when: '1 week ago' },
            { icon: MessageSquare, label: 'Texted about conference', when: '2 weeks ago' },
          ].map((item, i) => (
            <div key={i} className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2 text-af-text-primary font-body">
                <item.icon className="h-3.5 w-3.5 text-af-text-tertiary" />
                {item.label}
              </div>
              <span className="text-xs text-af-text-tertiary font-body">{item.when}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function IntentionTrackingDemo() {
  const intentions = [
    {
      label: 'Call Mom weekly',
      streak: 12,
      unit: 'week',
      icon: Phone,
      color: 'text-af-teal',
      bgColor: 'bg-af-teal/10',
      progress: Array.from({ length: 12 }, () => true),
    },
    {
      label: 'Coffee with Alex monthly',
      streak: 5,
      unit: 'month',
      icon: Coffee,
      color: 'text-af-accent',
      bgColor: 'bg-af-accent/10',
      progress: Array.from({ length: 6 }, (_, i) => i < 5),
    },
    {
      label: 'Text college friends weekly',
      streak: 8,
      unit: 'week',
      icon: MessageSquare,
      color: 'text-af-blue',
      bgColor: 'bg-af-blue/10',
      progress: Array.from({ length: 8 }, () => true),
    },
    {
      label: 'Dinner with partner weekly',
      streak: 24,
      unit: 'week',
      icon: Heart,
      color: 'text-pink-400',
      bgColor: 'bg-pink-400/10',
      progress: Array.from({ length: 8 }, () => true),
    },
  ]

  return (
    <div className="space-y-4">
      {intentions.map((item, i) => (
        <div key={i} className="glass-subtle rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className={`flex h-7 w-7 items-center justify-center rounded-md ${item.bgColor}`}>
                <item.icon className={`h-3.5 w-3.5 ${item.color}`} />
              </div>
              <span className="text-sm font-body text-af-text-primary">{item.label}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Flame className={`h-3.5 w-3.5 ${item.color}`} />
              <span className={`text-sm font-display font-bold ${item.color}`}>
                {item.streak} {item.unit} streak
              </span>
            </div>
          </div>
          <div className="flex gap-1">
            {item.progress.map((filled, j) => (
              <div
                key={j}
                className={`h-1.5 flex-1 rounded-full ${
                  filled ? item.bgColor.replace('/10', '/40') : 'bg-af-surface-raised'
                }`}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function GiftListDemo() {
  const gifts = [
    {
      person: 'Mom',
      occasion: 'Birthday (Mar 15)',
      ideas: [
        { name: 'Kindle Paperwhite', price: '$140', saved: true },
        { name: 'Cashmere scarf', price: '$85', saved: true },
        { name: 'Cooking class voucher', price: '$60', saved: false },
      ],
    },
    {
      person: 'Alex',
      occasion: 'Thank you gift',
      ideas: [
        { name: 'Premium coffee subscription', price: '$45/mo', saved: true },
        { name: 'Moleskine notebook set', price: '$35', saved: false },
      ],
    },
  ]

  return (
    <div className="space-y-4">
      {gifts.map((gift, i) => (
        <div key={i} className="glass-subtle rounded-lg p-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Gift className="h-4 w-4 text-af-accent" />
              <span className="text-sm font-display font-semibold text-af-text-primary">{gift.person}</span>
            </div>
            <Badge variant="secondary" className="text-2xs">{gift.occasion}</Badge>
          </div>
          <div className="space-y-1.5">
            {gift.ideas.map((idea, j) => (
              <div key={j} className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-body">
                  <Star className={`h-3 w-3 ${idea.saved ? 'text-af-accent fill-af-accent' : 'text-af-text-tertiary'}`} />
                  <span className="text-af-text-primary">{idea.name}</span>
                </div>
                <div className="flex items-center gap-1 text-xs text-af-text-tertiary font-body">
                  <DollarSign className="h-3 w-3" />
                  {idea.price}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function MeetingPrepDemo() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4 text-af-accent" />
          <span className="text-sm font-display font-semibold text-af-text-primary">
            Coffee with Alex Kim
          </span>
        </div>
        <Badge variant="secondary" className="text-2xs">Tomorrow, 10am</Badge>
      </div>

      <div className="glass-subtle rounded-lg p-3 space-y-3">
        <div>
          <p className="text-xs text-af-text-tertiary font-body uppercase tracking-wider mb-1.5">
            Key Talking Points
          </p>
          <ul className="space-y-1.5">
            {[
              'Congrats on Series B close (announced last week)',
              'Ask about new VP Eng hire they mentioned',
              'Follow up on book recommendation: Designing Data-Intensive Applications',
            ].map((point, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-af-text-primary font-body">
                <Sparkles className="h-3.5 w-3.5 text-af-accent shrink-0 mt-0.5" />
                {point}
              </li>
            ))}
          </ul>
        </div>

        <div className="border-t border-af-surface-border/30 pt-3">
          <p className="text-xs text-af-text-tertiary font-body uppercase tracking-wider mb-1.5">
            Recent Context
          </p>
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm text-af-text-secondary font-body">
              <Clock className="h-3.5 w-3.5 text-af-text-tertiary" />
              Last met 3 weeks ago at Blue Bottle
            </div>
            <div className="flex items-center gap-2 text-sm text-af-text-secondary font-body">
              <TrendingUp className="h-3.5 w-3.5 text-af-teal" />
              Relationship trending up (score: 92)
            </div>
          </div>
        </div>

        <div className="border-t border-af-surface-border/30 pt-3">
          <p className="text-xs text-af-text-tertiary font-body uppercase tracking-wider mb-1.5">
            Shared Interests
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary" className="text-2xs">Distributed Systems</Badge>
            <Badge variant="secondary" className="text-2xs">Running</Badge>
            <Badge variant="secondary" className="text-2xs">Japanese Whisky</Badge>
            <Badge variant="secondary" className="text-2xs">Board Games</Badge>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Page Component                                                     */
/* ------------------------------------------------------------------ */

export default function TourPage() {
  return (
    <div className="min-h-screen bg-af-bg-primary">
      <Navbar />

      {/* ---- Tour Hero ---- */}
      <section className="relative pt-32 pb-16 px-4 sm:px-6 lg:px-8 mesh-gradient overflow-hidden">
        <div className="absolute inset-0 grid-bg opacity-20 pointer-events-none" />
        <div className="relative mx-auto max-w-3xl text-center">
          <Badge variant="secondary" className="mb-6 inline-flex gap-1.5">
            <Target className="h-3 w-3 text-af-accent" />
            Product Tour
          </Badge>
          <h1 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold text-af-text-primary mb-6 leading-tight">
            See Supaku Family in action
          </h1>
          <p className="text-lg text-af-text-secondary font-body max-w-xl mx-auto leading-relaxed">
            Walk through the core features with real demo data. Discover how Supaku Family helps you stay intentional about the relationships that matter.
          </p>
        </div>
      </section>

      {/* ---- Tour Steps ---- */}
      <Section>
        <div className="space-y-24">
          <TourStep
            icon={Users}
            stepNumber={1}
            title="Contact View"
            description="Every contact is more than a name and number. Supaku Family enriches your contacts with context — company, location, how you met, recent interactions, and a real-time relationship health score. Everything you need to be a thoughtful friend, all in one place."
          >
            <ContactViewDemo />
          </TourStep>

          <TourStep
            icon={Target}
            stepNumber={2}
            title="Intention Tracking"
            description="Set intentions for how often you want to connect with the people who matter. Supaku Family tracks your streaks and nudges you when you're about to break one. It's like a fitness tracker for your relationships."
            reverse
          >
            <IntentionTrackingDemo />
          </TourStep>

          <TourStep
            icon={Gift}
            stepNumber={3}
            title="Gift List"
            description="Never scramble for a last-minute gift again. Save gift ideas as they come to you, organize by person and occasion, and track price ranges. When a birthday or holiday approaches, you're already prepared."
          >
            <GiftListDemo />
          </TourStep>

          <TourStep
            icon={FileText}
            stepNumber={4}
            title="Meeting Prep"
            description="Walking into a catch-up cold is a missed opportunity. Supaku Family generates a briefing card before each meeting with key talking points pulled from recent interactions, shared interests, and life events you've tracked."
            reverse
          >
            <MeetingPrepDemo />
          </TourStep>
        </div>
      </Section>

      {/* ---- CTA ---- */}
      <Section className="bg-af-bg-secondary/50">
        <div className="text-center">
          <h2 className="font-display text-3xl sm:text-4xl font-bold text-af-text-primary mb-4">
            Ready to invest in your relationships?
          </h2>
          <p className="text-lg text-af-text-secondary font-body max-w-xl mx-auto mb-8">
            Start your 14-day free trial today. No credit card required.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button asChild size="lg" className="glow-orange text-base px-8">
              <Link href="/#pricing">
                Start your free trial
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg" className="text-base px-8">
              <Link href="/">Back to home</Link>
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
