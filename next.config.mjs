import { withEve } from 'eve/next'

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Native / heavy server-only modules must never be bundled: better-sqlite3,
  // and the RoBERTa stack (onnxruntime-node) used by the two-tier route.
  experimental: {
    // @ax-llm/ax must stay external too: its AxJSRuntime imports node:worker_threads
    // at runtime, which a webpack bundle can't resolve.
    serverComponentsExternalPackages: ['better-sqlite3', '@huggingface/transformers', 'onnxruntime-node', '@ax-llm/ax'],
  },
}

// Hosts the eve agent (agent/) behind the Next app via rewrites, so the
// dashboard's chat can talk to it same-origin (useEveAgent host: '').
export default withEve(nextConfig)
