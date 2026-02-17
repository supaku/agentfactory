import type { Config } from 'tailwindcss'
import dashboardPreset from '@supaku/agentfactory-dashboard/tailwind-preset'

const config: Config = {
  presets: [dashboardPreset],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    '../../packages/dashboard/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontSize: {
        '5xl': ['3.75rem', { lineHeight: '4rem' }],
        '6xl': ['4.5rem', { lineHeight: '4.75rem' }],
      },
      keyframes: {
        'float': {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-12px)' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(24px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'count-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'float': 'float 6s ease-in-out infinite',
        'slide-up': 'slide-up 0.6s ease-out both',
        'count-up': 'count-up 0.4s ease-out both',
      },
    },
  },
  plugins: [],
}

export default config
