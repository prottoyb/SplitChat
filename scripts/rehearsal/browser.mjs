// Headless-Chrome driver over the DevTools protocol for SplitChat-Dev only
// (no new dependency: Node's WebSocket + fetch). Shared by the rendered
// review (render-review.mjs) and the E2E suite (scripts/e2e/e2e.mjs).
//
// Safety: the app is served by Vite with the SplitChat-Dev URL and key
// (process env beats .env.local, which targets PRODUCTION), and every browser
// request is intercepted: only the local app and the SplitChat-Dev origin
// are allowed; anything else is blocked and recorded as a violation.
//
// Elements are found the way people and assistive technology find them: by
// role and accessible name (button/link text or aria-label, a field's label),
// never by CSS class. Clicks are real mouse events at the element's centre;
// typing uses real text insertion.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { PROD_REF } from './dev.mjs'

export const CHROME = process.env.SPLITCHAT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

/** Starts Vite against SplitChat-Dev; resolves when it is listening. */
export async function startApp(t, port) {
  const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort'], {
    env: { ...process.env, VITE_SUPABASE_URL: t.url, VITE_SUPABASE_PUBLISHABLE_KEY: t.anonKey },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  vite.stdout.on('data', (d) => (out += d))
  vite.stderr.on('data', (d) => (out += d))
  for (let i = 0; !out.replace(/\x1b\[[0-9;]*m/g, '').includes('Local:'); i++) {
    if (i > 150) throw new Error(`vite did not start:\n${out}`)
    await sleep(200)
  }
  return { origin: `http://localhost:${port}`, stop: () => vite.kill() }
}

// In-page helpers (installed on every document).
const HELPERS = String.raw`
window.__e2e = (() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' }
  const labelOf = (el) => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label')
    const by = el.getAttribute('aria-labelledby')
    if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ')
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return l.textContent }
    const wrap = el.closest('label'); if (wrap) { const c = wrap.cloneNode(true); c.querySelectorAll('input,select,textarea,[aria-hidden="true"]').forEach((n) => n.remove()); return c.textContent }
    return el.getAttribute('placeholder') || ''
  }
  // Visible text without aria-hidden parts, as assistive technology reads it.
  const textOf = (el) => { const c = el.cloneNode(true); c.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove()); return c.textContent }
  const nameOf = (el) => norm(['BUTTON', 'A'].includes(el.tagName) || el.getAttribute('role') ? (el.getAttribute('aria-label') || textOf(el)) : labelOf(el))
  const SELECTORS = {
    button: 'button,[role="button"]', link: 'a[href]', textbox: 'input:not([type]),input[type="text"],input[type="email"],input[type="password"],input[type="number"],input[type="search"],textarea',
    date: 'input[type="date"]', combobox: 'select', checkbox: 'input[type="checkbox"]', heading: 'h1,h2,h3,h4,h5,h6',
    article: 'article', list: 'ul,ol,[role="list"],[role="log"]', navigation: 'nav', group: '[role="group"]', alert: '[role="alert"]', status: '[role="status"]',
  }
  const matches = (name, want) => want.startsWith('/') ? new RegExp(want.slice(1, want.lastIndexOf('/')), want.slice(want.lastIndexOf('/') + 1)).test(name) : name === want
  const all = (role, want, within) => [...(within || document).querySelectorAll(SELECTORS[role])].filter((el) => visible(el) && (want == null || matches(role === 'heading' ? norm(el.textContent) : nameOf(el), want)))
  let n = 0
  const tag = (el) => { if (!el.dataset.e2e) el.dataset.e2e = String(++n); return el.dataset.e2e }
  return { norm, all, tag, nameOf, text: () => norm(document.body.innerText) }
})()`

/** A Chrome instance (its own profile, so its own session) with one page. */
export async function openBrowser({ allowedOrigins, width = 1280, height = 900, mobile = false }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'splitchat-browser-'))
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' })
  const portFile = path.join(profile, 'DevToolsActivePort')
  for (let i = 0; !fs.existsSync(portFile); i++) {
    if (i > 150) throw new Error('chrome did not start')
    await sleep(100)
  }
  const cdpPort = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim()
  const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let nextId = 0
  const pending = new Map()
  const listeners = []
  const violations = []
  const consoleErrors = []
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data)
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id)
      pending.delete(data.id)
      return data.error ? reject(new Error(data.error.message)) : resolve(data.result)
    }
    for (const l of listeners) l(data)
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  const allowed = new Set(allowedOrigins)
  listeners.push((event) => {
    if (event.method === 'Runtime.exceptionThrown') consoleErrors.push(event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text)
    if (event.method !== 'Fetch.requestPaused') return
    const { requestId, request } = event.params
    let ok = /^(data|blob):/.test(request.url)
    try {
      ok ||= allowed.has(new URL(request.url).origin)
    } catch {
      ok = false
    }
    if (ok && !request.url.includes(PROD_REF)) void send('Fetch.continueRequest', { requestId })
    else {
      violations.push(request.url)
      void send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
    }
  })
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS })
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
  if (mobile) {
    await send('Emulation.setTouchEmulationEnabled', { enabled: true })
    // As on a phone: (pointer: coarse) and (hover: none) media queries apply.
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] })
  }

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value
  }

  const page = {
    send,
    evaluate,
    violations,
    consoleErrors,
    async goto(url) {
      await send('Page.navigate', { url })
      await page.waitFor('document.readyState === "complete" && !!window.__e2e', 20000, `load ${url}`)
    },
    /** Polls a page expression until truthy. */
    async waitFor(expression, ms = 15000, what = expression) {
      for (let waited = 0; ; waited += 200) {
        try {
          if (await evaluate(expression)) return
        } catch {
          // navigating
        }
        if (waited >= ms) throw new Error(`timed out waiting for ${what}`)
        await sleep(200)
      }
    },
    async waitForText(text, ms = 15000) {
      await page.waitFor(`window.__e2e.text().includes(${JSON.stringify(text)})`, ms, `text "${text}"`)
    },
    async hasText(text) {
      return evaluate(`window.__e2e.text().includes(${JSON.stringify(text)})`)
    },
    /** Tags the first visible element with this role and accessible name (optionally inside an element tag); returns its tag. */
    async find(role, name, { within = null, ms = 15000 } = {}) {
      const scope = within ? `document.querySelector('[data-e2e="${within}"]')` : 'null'
      const expr = `(() => { const el = window.__e2e.all(${JSON.stringify(role)}, ${JSON.stringify(name)}, ${scope})[0]; return el ? window.__e2e.tag(el) : null })()`
      let tag = null
      await page.waitFor(`(${expr}) !== null`, ms, `${role} "${name}"`)
      tag = await evaluate(expr)
      return tag
    },
    async count(role, name, within = null) {
      const scope = within ? `document.querySelector('[data-e2e="${within}"]')` : 'null'
      return evaluate(`window.__e2e.all(${JSON.stringify(role)}, ${JSON.stringify(name)}, ${scope}).length`)
    },
    async isDisabled(tag) {
      return evaluate(`document.querySelector('[data-e2e="${tag}"]').disabled === true`)
    },
    /** A real mouse click at the element's centre (hit-testing included). */
    async click(role, name, opts) {
      const tag = await page.find(role, name, opts)
      const box = await evaluate(`(() => { const el = document.querySelector('[data-e2e="${tag}"]'); el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
      const hit = await evaluate(`(() => { const t = document.querySelector('[data-e2e="${tag}"]'); const at = document.elementFromPoint(${box.x}, ${box.y}); return !!at && (at === t || t.contains(at)) })()`)
      if (!hit) throw new Error(`${role} "${name}" is covered by another element`)
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
      }
      return tag
    },
    /** Focuses a field by its label and types into it (replacing its value). */
    async type(name, text, { role = 'textbox', within = null } = {}) {
      const tag = await page.find(role, name, { within })
      await evaluate(`(() => { const el = document.querySelector('[data-e2e="${tag}"]'); el.scrollIntoView({ block: 'center' }); el.focus(); el.select?.() })()`)
      await send('Input.insertText', { text })
      return tag
    },
    /** Sets a date or select control's value the way a picker would. */
    async choose(role, name, value) {
      const tag = await page.find(role, name)
      await evaluate(`(() => { const el = document.querySelector('[data-e2e="${tag}"]');
        const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })) })()`)
    },
    async press(key) {
      const codes = { Enter: 13, Tab: 9, Escape: 27, Space: 32 }
      const text = key === 'Enter' ? '\r' : key === 'Space' ? ' ' : undefined
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: codes[key], text })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: codes[key] })
    },
    async screenshot(file, fullPage = true) {
      const { result } = await send('Runtime.evaluate', { expression: 'document.documentElement.scrollHeight', returnByValue: true })
      const { layoutViewport } = await send('Page.getLayoutMetrics')
      const { data } = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: fullPage,
        clip: { x: 0, y: 0, width: layoutViewport.clientWidth, height: fullPage ? Math.min(result.value, 6000) : layoutViewport.clientHeight, scale: 1 },
      })
      fs.writeFileSync(file, Buffer.from(data, 'base64'))
    },
    async close() {
      ws.close()
      chrome.kill()
      await sleep(400)
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 })
    },
  }
  return page
}
