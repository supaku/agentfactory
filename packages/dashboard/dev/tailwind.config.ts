import type { Config } from 'tailwindcss'
import dashboardPreset from '../tailwind.config'

const config: Config = {
  presets: [dashboardPreset],
  content: [
    './app/**/*.{ts,tsx}',
    '../src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}

export default config
