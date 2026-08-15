// Smoke test for the dsh-vision-primitives bundle entry (index.js).
// Verifies: plugin body loads, all tools register through the harness facade,
// the settings namespace installs (with the mock settings service), the
// paste-to-path route registers and answers a text-only-model verdict, and no
// dynamic-sandbox-only global is referenced at apply time.
import { apply, Config } from './index.js'

const registered = []
const disposers = []
let installedNs = null

const stubFs = {
  resolve: async (p) => p,
  readText: async () => '',
  writeText: async () => {},
  readBytes: async () => new Uint8Array(0)
}
const stubSp = {
  resolveExecutable: async () => 'mock',
  spawn: async () => { throw new Error('spawn should not be called during registration') }
}

const mockSettings = {
  register(ns, schema, opts) {
    installedNs = { ns, schema, base: opts && opts.base }
    return {
      get: () => ({ apiKey: '', baseUrl: 'https://example.com/v1', model: 'mimo-mock', timeoutMs: 111000, pasteToPath: true, autoDescribe: true }),
      watch: () => () => {}
    }
  }
}

const webRoutes = []
const mockWebServer = {
  register(route) {
    webRoutes.push(route)
    return () => {}
  }
}

const ctx = {
  get(name) {
    if (name === 'fs') return stubFs
    if (name === 'subprocess') return stubSp
    if (name === 'settings') return mockSettings
    if (name === 'webServer') return mockWebServer
    return undefined
  },
  inject(names, cb) {
    if (Array.isArray(names) && names.includes('settings') && typeof cb === 'function') {
      cb({ settings: mockSettings, effect: (fn) => { const d = fn(); return () => { if (d) d() } } })
      return () => {}
    }
    return () => {}
  },
  tools: {
    register(tool) {
      registered.push(tool.name)
      const d = () => { disposers.push(tool.name) }
      return d
    }
  },
  effect(fn) {
    const d = fn()
    return () => { if (d) d() }
  }
}

const config = { baseUrl: 'https://from-config.example', model: 'mimo-config', timeoutMs: 555000, pasteToPath: true, autoDescribe: true }
const result = apply(ctx, config)

const expected = [
  'vision_capture', 'vision_grid', 'vision_resolve', 'vision_zoom',
  'vision_annotate', 'vision_measure', 'vision_diff', 'vision_find_color',
  'vision_ocr', 'vision_describe', 'vision_locate', 'vision_analyze',
  'vision_state', 'vision_reset'
]

let ok = true
for (const name of expected) {
  if (!registered.includes(name)) { ok = false; console.error('MISSING:', name) }
}
if (registered.length !== expected.length) { ok = false; console.error('unexpected extra tools:', registered.filter((n) => !expected.includes(n))) }
if (!installedNs) { ok = false; console.error('settings namespace was not installed') }
if (typeof Config !== 'function') { ok = false; console.error('Config is not a schemastery schema') }

// Exercise the paste route verdict (text-only model → takeover:true).
const pasteRoute = webRoutes.find((r) => r.path === '/vision-primitives/paste')
if (!pasteRoute) { ok = false; console.error('paste route not registered') } else {
  const res = {
    status: 0,
    body: '',
    writeHead(s, h) { this.status = s; this.headers = h },
    end(b) { this.body = String(b || '') }
  }
  await pasteRoute.handler({ method: 'GET', url: '/vision-primitives/paste?model=DeepSeek', on() {} }, res)
  const verdict = JSON.parse(res.body)
  if (res.status !== 200 || verdict.takeover !== true) { ok = false; console.error('paste verdict wrong:', res.status, res.body) }
  console.log('paste verdict (text-only model):', JSON.stringify(verdict))
}

console.log('registered:', registered.length, 'tools')
console.log('settings ns installed:', installedNs && installedNs.ns, '| base:', installedNs && JSON.stringify(installedNs.base))
console.log('config keys:', Object.keys(config).join(','))
if (ok) { console.log('SMOKE PASS') } else { console.log('SMOKE FAIL'); process.exit(1) }
