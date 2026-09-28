#!/usr/bin/env node
// Self-test of the browser safety guard in browser.mjs (Phase 8). Needs only
// Chrome: no SplitChat-Dev credentials, no app server, no project contacted
// (the probed hosts are unresolvable or refused; the guard judges each
// connection when the browser creates it, before any network result).
//
// Proves, in a real headless Chrome:
//   1. a WebSocket to an origin outside the allowlist is a violation;
//   2. a WebSocket whose URL contains the production ref is a violation;
//   3. an HTTP request to an origin outside the allowlist is blocked and is a
//      violation;
//   4. control: a WebSocket and a request to the allowed origin are NOT
//      violations (so 1-3 are not vacuous);
//   5. the WebSocket listener actually observed every socket opened.
// Exits 1 on any failure.
//
//   node scripts/rehearsal/browser-guard-selftest.mjs

import { setTimeout as sleep } from 'node:timers/promises'
import { openBrowser } from './browser.mjs'
import { PROD_REF } from './dev.mjs'

const ALLOWED = 'http://localhost:9' // discard port: nothing listens
const redact = (url) => url.replaceAll(PROD_REF, '<production-ref>')

const page = await openBrowser({ allowedOrigins: [ALLOWED] })
let failed = false
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
  if (!ok) failed = true
}

try {
  await page.send('Page.navigate', { url: 'data:text/html,<title>guard self-test</title><p>guard self-test</p>' })
  await sleep(800)

  const unknownWs = 'wss://splitchat-guard-selftest.invalid/socket'
  const prodWs = `wss://${PROD_REF}.supabase.co/realtime/v1/websocket?selftest=1`
  const allowedWs = 'ws://localhost:9/socket'
  const unknownHttp = 'https://splitchat-guard-selftest.invalid/rest'
  const allowedHttp = `${ALLOWED}/control`

  await page.evaluate(`(() => {
    for (const u of ${JSON.stringify([unknownWs, prodWs, allowedWs])}) { try { new WebSocket(u) } catch {} }
    for (const u of ${JSON.stringify([unknownHttp, allowedHttp])}) fetch(u).catch(() => {})
    return true
  })()`)
  await sleep(2000)

  const v = page.violations
  check('WebSocket to an unapproved origin is a violation', v.includes(unknownWs))
  check('WebSocket containing the production ref is a violation', v.includes(prodWs))
  check('HTTP request to an unapproved origin is a violation', v.includes(unknownHttp))
  check('control: WebSocket to the allowed origin is not a violation', !v.includes(allowedWs))
  check('control: HTTP request to the allowed origin is not a violation', !v.includes(allowedHttp))
  check('every WebSocket was observed by the guard', [unknownWs, prodWs, allowedWs].every((u) => page.webSockets.includes(u)), `${page.webSockets.length} seen`)
  check('no other violations', v.length === 3, v.map(redact).join(', '))
} catch (error) {
  console.log(`FAIL  self-test error: ${redact(error.message)}`)
  failed = true
} finally {
  await page.close()
}
console.log(failed ? '\nBROWSER GUARD SELF-TEST FAILED' : '\nBROWSER GUARD SELF-TEST PASSED')
process.exit(failed ? 1 : 0)
