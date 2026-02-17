import { describe, it, expect } from 'vitest'
import {
  contactToVCard,
  contactsToVCard,
  toCSV,
  flattenContactForCSV,
  exportContacts,
  exportActivities,
  exportGifts,
  buildExportFiles,
} from '../privacy/data-export.js'
import type { ExportContact, ExportActivity, ExportGift, ExportUserData } from '../privacy/data-export.js'

const sampleContact: ExportContact = {
  id: 'contact-1',
  firstName: 'John',
  lastName: 'Doe',
  email: 'john@example.com',
  phone: '+1-555-0100',
  organization: 'Acme Corp',
  title: 'CTO',
  birthday: '1990-01-15',
  address: {
    street: '123 Main St',
    city: 'Springfield',
    state: 'IL',
    postalCode: '62701',
    country: 'US',
  },
  notes: 'Met at conference',
  tags: ['friend', 'tech'],
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-06-15T12:00:00Z',
}

const sampleActivity: ExportActivity = {
  id: 'activity-1',
  contactId: 'contact-1',
  type: 'meeting',
  title: 'Coffee catch-up',
  description: 'Discussed project ideas',
  date: '2024-06-01',
  createdAt: '2024-06-01T10:00:00Z',
}

const sampleGift: ExportGift = {
  id: 'gift-1',
  contactId: 'contact-1',
  contactName: 'John Doe',
  title: 'Birthday gift',
  description: 'A nice book',
  occasion: 'Birthday',
  date: '2024-01-15',
  status: 'purchased',
  createdAt: '2024-01-10T00:00:00Z',
}

describe('privacy/data-export', () => {
  describe('contactToVCard', () => {
    it('generates valid vCard 3.0 format', () => {
      const vcard = contactToVCard(sampleContact)

      expect(vcard).toContain('BEGIN:VCARD')
      expect(vcard).toContain('VERSION:3.0')
      expect(vcard).toContain('END:VCARD')
      expect(vcard).toContain('FN:John Doe')
      expect(vcard).toContain('N:Doe;John;;;')
      expect(vcard).toContain('EMAIL;TYPE=INTERNET:john@example.com')
      expect(vcard).toContain('TEL;TYPE=CELL:+1-555-0100')
      expect(vcard).toContain('ORG:Acme Corp')
      expect(vcard).toContain('TITLE:CTO')
      expect(vcard).toContain('BDAY:1990-01-15')
      expect(vcard).toContain('NOTE:Met at conference')
      expect(vcard).toContain('CATEGORIES:friend,tech')
      expect(vcard).toContain('UID:contact-1')
    })

    it('handles minimal contact', () => {
      const minimal: ExportContact = {
        id: 'contact-min',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      }

      const vcard = contactToVCard(minimal)
      expect(vcard).toContain('BEGIN:VCARD')
      expect(vcard).toContain('VERSION:3.0')
      expect(vcard).toContain('UID:contact-min')
      expect(vcard).toContain('END:VCARD')
    })

    it('escapes special characters in vCard values', () => {
      const contact: ExportContact = {
        id: 'contact-special',
        firstName: 'John;Doe',
        notes: 'Line 1\nLine 2',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      }

      const vcard = contactToVCard(contact)
      expect(vcard).toContain('FN:John\\;Doe')
      expect(vcard).toContain('NOTE:Line 1\\nLine 2')
    })
  })

  describe('contactsToVCard', () => {
    it('joins multiple contacts with newlines', () => {
      const contacts = [sampleContact, { ...sampleContact, id: 'contact-2', firstName: 'Jane' }]
      const vcards = contactsToVCard(contacts)

      const matches = vcards.match(/BEGIN:VCARD/g)
      expect(matches).toHaveLength(2)
    })
  })

  describe('toCSV', () => {
    it('generates valid CSV with header', () => {
      const records = [
        { name: 'John', age: 30 },
        { name: 'Jane', age: 25 },
      ]

      const csv = toCSV(records)
      const lines = csv.split('\n')

      expect(lines[0]).toBe('name,age')
      expect(lines[1]).toBe('John,30')
      expect(lines[2]).toBe('Jane,25')
    })

    it('escapes fields with commas and quotes', () => {
      const records = [
        { name: 'Doe, John', note: 'He said "hello"' },
      ]

      const csv = toCSV(records)
      const lines = csv.split('\n')
      expect(lines[1]).toBe('"Doe, John","He said ""hello"""')
    })

    it('handles empty records', () => {
      const csv = toCSV([])
      expect(csv).toBe('')
    })

    it('respects custom column order', () => {
      const records = [{ b: 2, a: 1 }]
      const csv = toCSV(records, ['a', 'b'])
      expect(csv.split('\n')[0]).toBe('a,b')
    })
  })

  describe('flattenContactForCSV', () => {
    it('flattens nested address', () => {
      const flat = flattenContactForCSV(sampleContact)
      expect(flat.street).toBe('123 Main St')
      expect(flat.city).toBe('Springfield')
      expect(flat.tags).toBe('friend; tech')
    })
  })

  describe('exportContacts', () => {
    it('exports as vcard', () => {
      const result = exportContacts([sampleContact], 'vcard')
      expect(result).toContain('BEGIN:VCARD')
    })

    it('exports as csv', () => {
      const result = exportContacts([sampleContact], 'csv')
      expect(result).toContain('firstName')
      expect(result).toContain('John')
    })

    it('exports as json', () => {
      const result = exportContacts([sampleContact], 'json')
      const parsed = JSON.parse(result)
      expect(parsed).toHaveLength(1)
      expect(parsed[0].id).toBe('contact-1')
    })
  })

  describe('exportActivities', () => {
    it('exports as csv', () => {
      const result = exportActivities([sampleActivity], 'csv')
      expect(result).toContain('type')
      expect(result).toContain('meeting')
    })

    it('exports as json', () => {
      const result = exportActivities([sampleActivity], 'json')
      const parsed = JSON.parse(result)
      expect(parsed[0].title).toBe('Coffee catch-up')
    })
  })

  describe('exportGifts', () => {
    it('exports as csv', () => {
      const result = exportGifts([sampleGift], 'csv')
      expect(result).toContain('occasion')
      expect(result).toContain('Birthday')
    })

    it('exports as json', () => {
      const result = exportGifts([sampleGift], 'json')
      const parsed = JSON.parse(result)
      expect(parsed[0].status).toBe('purchased')
    })
  })

  describe('buildExportFiles', () => {
    it('builds a complete export file map', () => {
      const data: ExportUserData = {
        user: { id: 'user-1', email: 'test@example.com', createdAt: '2024-01-01T00:00:00Z' },
        contacts: [sampleContact],
        activities: [sampleActivity],
        gifts: [sampleGift],
        auditLog: [{ action: 'test', timestamp: 12345 }],
        exportedAt: '2024-07-01T00:00:00Z',
      }

      const files = buildExportFiles(data)

      // Check expected files
      expect(files.has('contacts/contacts.vcf')).toBe(true)
      expect(files.has('contacts/contacts.csv')).toBe(true)
      expect(files.has('contacts/contacts.json')).toBe(true)
      expect(files.has('activities/activities.json')).toBe(true)
      expect(files.has('activities/activities.csv')).toBe(true)
      expect(files.has('gifts/gifts.json')).toBe(true)
      expect(files.has('gifts/gifts.csv')).toBe(true)
      expect(files.has('audit-log/audit-log.json')).toBe(true)
      expect(files.has('profile/user.json')).toBe(true)
      expect(files.has('manifest.json')).toBe(true)

      // Check manifest
      const manifest = JSON.parse(files.get('manifest.json')!)
      expect(manifest.version).toBe('1.0.0')
      expect(manifest.userId).toBe('user-1')
      expect(manifest.files.length).toBeGreaterThan(0)
    })

    it('handles empty data', () => {
      const data: ExportUserData = {
        user: { id: 'user-1', email: 'test@example.com', createdAt: '2024-01-01T00:00:00Z' },
        contacts: [],
        activities: [],
        gifts: [],
        auditLog: [],
        exportedAt: '2024-07-01T00:00:00Z',
      }

      const files = buildExportFiles(data)

      // Should still have profile and manifest
      expect(files.has('profile/user.json')).toBe(true)
      expect(files.has('manifest.json')).toBe(true)

      // Should NOT have empty entity files
      expect(files.has('contacts/contacts.vcf')).toBe(false)
      expect(files.has('activities/activities.json')).toBe(false)
      expect(files.has('gifts/gifts.json')).toBe(false)
    })
  })
})
