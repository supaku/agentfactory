'use client'

import { FaqItem } from '@/components/faq-item'

const faqs = [
  {
    question: 'Why no free tier?',
    answer:
      'Free tiers are funded by advertising or selling user data. Your personal relationships are too sensitive for that trade-off. By charging a fair price, we can build sustainable software that puts your privacy first and never needs to monetize your data.',
  },
  {
    question: 'Can I import my existing contacts?',
    answer:
      'Yes. Supaku Family supports importing from CSV, vCard, Google Contacts, and Apple Contacts. Our import wizard maps your fields automatically and handles duplicates intelligently.',
  },
  {
    question: 'What happens to my data if I cancel?',
    answer:
      'Your data remains available for 30 days after cancellation. During that period you can export everything in CSV or JSON format. After 30 days, we permanently delete all your data from our servers — no retention, no backups kept.',
  },
  {
    question: 'Is my data encrypted?',
    answer:
      'Absolutely. All data is encrypted in transit using TLS 1.3 and at rest using AES-256 encryption. Personal notes and sensitive relationship details use an additional layer of encryption that even our team cannot access.',
  },
  {
    question: 'Can I export my data anytime?',
    answer:
      'Yes, always. You can export your full dataset — contacts, notes, interactions, gift lists, everything — in standard CSV or JSON format at any time from your settings page. No restrictions, no waiting periods.',
  },
  {
    question: 'How is this different from a spreadsheet?',
    answer:
      'A spreadsheet can store names and numbers but cannot track relationship health, surface smart reminders, generate context-aware message suggestions, or provide meeting prep briefings. Supaku Family is purpose-built for nurturing relationships, not just listing them.',
  },
]

export function FaqAccordion() {
  return (
    <div className="divide-af-surface-border/50">
      {faqs.map((faq, i) => (
        <FaqItem key={i} question={faq.question} answer={faq.answer} defaultOpen={i === 0} />
      ))}
    </div>
  )
}
