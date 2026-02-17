/**
 * Privacy Policy & Terms of Service
 *
 * GET /api/gdpr/privacy-policy — Returns the privacy policy
 * GET /api/gdpr/tos — Returns the terms of service
 *
 * Auto-generated transparency page showing:
 * - What data is collected and why
 * - Connected integrations and what they access
 * - Data processing activities
 * - Cookie usage (minimal — session only)
 * - User rights (export, deletion, consent)
 */

import { NextResponse } from 'next/server'
import { createLogger } from '@supaku/agentfactory-server'

const log = createLogger('api:gdpr:privacy-policy')

export interface PrivacyPolicyConfig {
  /** Application name */
  appName: string
  /** Company or developer name */
  companyName: string
  /** Contact email for privacy inquiries */
  privacyEmail: string
  /** App URL */
  appUrl: string
  /** Connected integrations and what data they access */
  integrations?: Array<{
    name: string
    dataAccessed: string[]
    purpose: string
  }>
  /** Additional data processing activities */
  processingActivities?: Array<{
    activity: string
    lawfulBasis: string
    dataTypes: string[]
    retention: string
  }>
}

export function createPrivacyPolicyHandler(config: PrivacyPolicyConfig) {
  return async function GET() {
    const policy = generatePrivacyPolicy(config)
    return NextResponse.json(policy)
  }
}

export function createTosHandler(config: PrivacyPolicyConfig) {
  return async function GET() {
    const tos = generateTermsOfService(config)
    return NextResponse.json(tos)
  }
}

function generatePrivacyPolicy(config: PrivacyPolicyConfig) {
  const lastUpdated = new Date().toISOString().split('T')[0]

  return {
    title: `${config.appName} Privacy Policy`,
    lastUpdated,
    sections: [
      {
        heading: 'Introduction',
        content: `${config.appName} ("we", "us", "our") is committed to protecting your privacy. This policy explains how we collect, use, and protect your personal data in compliance with the General Data Protection Regulation (GDPR) and other applicable privacy laws.`,
      },
      {
        heading: 'Data We Collect',
        content: 'We collect only the data necessary to provide our service.',
        items: [
          'Account information: email address, name (provided by you)',
          'Contact data: names, emails, phones, addresses (provided by you or via connected integrations)',
          'Activity data: interactions, notes, journal entries (provided by you)',
          'Usage data: session cookies for authentication (functional, not tracking)',
        ],
      },
      {
        heading: 'How We Use Your Data',
        items: [
          'Providing the core CRM functionality',
          'Contact enrichment (only when you initiate it)',
          'Data export and portability',
          'Account management and authentication',
        ],
      },
      {
        heading: 'Data Enrichment',
        content: 'We only enrich contact data when you explicitly initiate it. Every enrichment is logged with its source and can be reversed with one click. We never enrich data automatically or sell your data to third parties.',
      },
      {
        heading: 'Connected Integrations',
        content: config.integrations && config.integrations.length > 0
          ? 'The following integrations may access your data when connected:'
          : 'No third-party integrations are currently connected.',
        items: config.integrations?.map(
          (i) => `${i.name}: accesses ${i.dataAccessed.join(', ')} for ${i.purpose}`
        ),
      },
      {
        heading: 'Data Processing Activities',
        content: 'Our lawful basis for processing your data:',
        items: [
          'Account management: contractual necessity',
          'Contact storage: contractual necessity',
          'Data enrichment: legitimate interest (user-initiated only)',
          'Session cookies: legitimate interest (functional necessity)',
          ...(config.processingActivities?.map(
            (a) => `${a.activity}: ${a.lawfulBasis} (${a.dataTypes.join(', ')}, retained for ${a.retention})`
          ) ?? []),
        ],
      },
      {
        heading: 'Cookies',
        content: 'We use only functional session cookies for authentication. We do not use tracking cookies, analytics cookies, or advertising cookies.',
      },
      {
        heading: 'Your Rights',
        items: [
          'Right to access: Export all your data at any time (Settings → Export Data)',
          'Right to erasure: Delete your account and all data (Settings → Delete Account)',
          'Right to portability: Export contacts as vCard, CSV, or JSON',
          'Right to rectification: Edit or correct any of your data',
          'Right to object: Revoke consent for optional processing (Settings → Privacy)',
          'Right to restrict processing: Contact us to restrict specific processing',
        ],
      },
      {
        heading: 'Data Security',
        items: [
          'AES-256-GCM encryption for sensitive fields (journal entries, API keys)',
          'Per-user encryption key derivation',
          'Audit logging of all data access events',
          'Encrypted data at rest (database-level)',
          'TLS encryption in transit',
        ],
      },
      {
        heading: 'Data Retention',
        items: [
          'Account data: retained while account is active',
          'After account deletion request: 30-day grace period, then permanently deleted',
          'Audit logs: retained for 90 days',
          'Session data: automatically expired after 24 hours',
        ],
      },
      {
        heading: 'Contact',
        content: `For privacy inquiries, contact us at ${config.privacyEmail}. You have the right to lodge a complaint with your local data protection authority.`,
      },
    ],
  }
}

function generateTermsOfService(config: PrivacyPolicyConfig) {
  const lastUpdated = new Date().toISOString().split('T')[0]

  return {
    title: `${config.appName} Terms of Service`,
    lastUpdated,
    sections: [
      {
        heading: 'Acceptance of Terms',
        content: `By using ${config.appName}, you agree to these terms. If you do not agree, do not use the service.`,
      },
      {
        heading: 'Service Description',
        content: `${config.appName} is a personal CRM service that helps you manage your personal relationships, contacts, and interactions.`,
      },
      {
        heading: 'Your Data',
        content: 'You own your data. We provide tools to export, modify, and delete all of your data at any time. We will never sell your data to third parties.',
      },
      {
        heading: 'Data Portability',
        content: 'You can export all your data at any time in standard formats (vCard, CSV, JSON). There is no lock-in.',
      },
      {
        heading: 'Account Termination',
        content: 'You may delete your account at any time. After a 30-day grace period (during which you can recover your account), all data is permanently deleted.',
      },
      {
        heading: 'Contact',
        content: `For questions about these terms, contact us at ${config.privacyEmail}.`,
      },
    ],
  }
}
