/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// The production Supabase project (public ref; it is in every production
// bundle). `.env.local` points at it, so local tooling guards against it.
const PRODUCTION_REF = 'jhftlnsccurhfgneltgi'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // `npm run dev` never talks to production by accident: point
  // VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY at SplitChat-Dev (process
  // env beats .env files), or opt in explicitly for a deliberate session.
  if (command === 'serve' && mode !== 'test') {
    const url = process.env.VITE_SUPABASE_URL ?? loadEnv(mode, process.cwd(), 'VITE_').VITE_SUPABASE_URL ?? ''
    if (url.includes(PRODUCTION_REF) && process.env.SPLITCHAT_DEV_ALLOW_PRODUCTION !== 'yes') {
      throw new Error(
        'Refusing to start the dev server against the PRODUCTION Supabase project. ' +
          'Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to SplitChat-Dev, ' +
          'or set SPLITCHAT_DEV_ALLOW_PRODUCTION=yes for a deliberate production session.',
      )
    }
  }
  return {
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Vendor code changes far less often than app code: separate chunks
        // stay cached across deploys (Phase 8 bundle review).
        manualChunks(id: string) {
          if (id.includes('node_modules/@supabase/')) return 'vendor-supabase'
          if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)) return 'vendor-react'
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    restoreMocks: true,
    // Tests never see a real project: an unmocked call fails closed.
    env: {
      VITE_SUPABASE_URL: 'https://supabase.test.invalid',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key',
    },
  },
  }
})
