import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  transpilePackages: ['@supaku/agentfactory-dashboard'],
  output: 'export',
}

export default nextConfig
