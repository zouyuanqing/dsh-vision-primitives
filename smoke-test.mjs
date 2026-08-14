// Smoke test for the dsh-vision-primitives bundle entry (index.js).
// Verifies: plugin body loads, all tools register through the harness facade,
// and no dynamic-sandbox-only global is referenced at apply time.
import { apply } from './index.js'

const registered = []
const disposers = []

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

const ctx = {
  get(name) {
    if (name === 'fs') return stubFs
    if (name === 'subprocess') return stubSp
    return undefined
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

const result = apply(ctx)

const expected = [
  'vision_capture', 'vision_grid', 'vision_resolve', 'vision_zoom',
  'vision_annotate', 'vision_measure', 'vision_diff', 'vision_find_color',
  'vision_ocr', 'vision_describe', 'vision_locate', 'vision_state', 'vision_reset'
]

let ok = true
for (const name of expected) {
  if (!registered.includes(name)) { ok = false; console.error('MISSING:', name) }
}
if (registered.length !== expected.length) { ok = false; console.error('unexpected extra tools:', registered.filter((n) => !expected.includes(n))) }

console.log('registered:', registered.length, 'tools')
console.log('result keys:', result ? Object.keys(result) : '(undefined)')
if (ok) { console.log('SMOKE PASS') } else { console.log('SMOKE FAIL'); process.exit(1) }
