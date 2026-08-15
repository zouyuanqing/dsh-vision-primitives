// Smoke test for the dsh-vision-primitives bundle entry (index.js).
// Verifies: plugin body loads, all tools register through the harness facade,
// the settings namespace installs (with the mock settings service), the
// paste-to-path route registers and answers a text-only-model verdict, the
// send-time image bridge wraps llm.resolveModelInfo / llm.streamWithRegistration
// (image blocks rewritten to text for text-only models, left intact for
// vision models), and no dynamic-sandbox-only global is referenced at apply time.
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
      get: () => ({ apiKey: '', baseUrl: 'https://example.com/v1', model: 'mimo-mock', timeoutMs: 111000, pasteToPath: true, autoDescribe: true, sendTimeConvert: true }),
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

// Mock llm service: text-only by default, 'vision-model' reports image support.
const streamCalls = []
const mockLlm = {
  registerAdapter() {
    return () => {}
  },
  async resolveModelInfo(provider, model) {
    return model === 'vision-model' ? { provider, id: model, inputModalities: ['text', 'image'] } : { provider, id: model, inputModalities: ['text'] }
  },
  streamWithRegistration(options, prepared) {
    streamCalls.push({ options, prepared })
    return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
  }
}
const mockAttachments = {
  async readImage() {
    throw new Error('mock: readImage unavailable (materialize falls back to text)')
  }
}

const ctx = {
  get(name) {
    if (name === 'fs') return stubFs
    if (name === 'subprocess') return stubSp
    if (name === 'settings') return mockSettings
    if (name === 'webServer') return mockWebServer
    if (name === 'llm') return mockLlm
    if (name === 'attachments') return mockAttachments
    return undefined
  },
  inject(names, cb) {
    if (Array.isArray(names) && typeof cb === 'function') {
      if (names.includes('webServer')) {
        cb({ webServer: mockWebServer, effect: (fn) => { const d = fn(); return () => { if (d) d() } } })
        return () => {}
      }
      if (names.includes('settings')) {
        cb({ settings: mockSettings, effect: (fn) => { const d = fn(); return () => { if (d) d() } } })
        return () => {}
      }
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

const config = { baseUrl: 'https://from-config.example', model: 'mimo-config', timeoutMs: 555000, pasteToPath: true, autoDescribe: true, sendTimeConvert: true }
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

// --- bridge: resolveModelInfo wrapped (text-only gains 'image') ---
const bridgedInfo = await mockLlm.resolveModelInfo('p', 'text-model')
if (!bridgedInfo.inputModalities.includes('image')) { ok = false; console.error('bridge: resolveModelInfo not wrapped (no image modality injected)') }
const visionInfo = await mockLlm.resolveModelInfo('p', 'vision-model')
if (!visionInfo.inputModalities.includes('image')) { ok = false; console.error('bridge: vision model resolve broken') }
console.log('bridge resolveModelInfo: text-model →', JSON.stringify(bridgedInfo.inputModalities))

// --- bridge: image block rewritten for text-only model ---
const textOnlyMsg = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } }] }]
const stream = mockLlm.streamWithRegistration({ provider: 'p', model: 'text-model', messages: textOnlyMsg })
for await (const _ of stream) { /* drain */ }
const seen = streamCalls[streamCalls.length - 1].options.messages[0].content[0]
if (seen.type !== 'text' || seen.text.indexOf('Attached image') < 0 && seen.text.indexOf('失败') < 0) { ok = false; console.error('bridge: image block not rewritten for text-only model:', JSON.stringify(seen).slice(0, 200)) }
console.log('bridge rewrite (text-only):', JSON.stringify(seen).slice(0, 140))

// --- bridge: vision model untouched ---
const visionMsg = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a2', mediaType: 'image/png' } }] }]
const stream2 = mockLlm.streamWithRegistration({ provider: 'p', model: 'vision-model', messages: visionMsg })
for await (const _ of stream2) { /* drain */ }
const seen2 = streamCalls[streamCalls.length - 1].options.messages[0].content[0]
if (seen2.type !== 'image') { ok = false; console.error('bridge: vision-model message was rewritten:', JSON.stringify(seen2).slice(0, 160)) }
console.log('bridge rewrite (vision model): untouched =', seen2.type === 'image')

// --- paste route verdict (text-only model → takeover:true) ---
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
