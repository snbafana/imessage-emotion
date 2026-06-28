import { withEve } from 'eve/next'

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // better-sqlite3 is a native module; never bundle it.
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3'],
  },
}

// Hosts the eve agent (agent/) behind the Next app via rewrites, so the
// dashboard's chat can talk to it same-origin (useEveAgent host: '').
export default withEve(nextConfig)
