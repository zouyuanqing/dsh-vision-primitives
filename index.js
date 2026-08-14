/**
 * dsh-vision-primitives — bundle entry point.
 *
 * The plugin body lives in plugin.host.js as the exact function body used by
 * the DeepSeek Harness dynamic-plugin sandbox (`return { name, inject,
 * apply(ctx) }`). This entry mounts the same body as an ordinary Cordis
 * plugin so the package can be installed through the official profile bundle
 * path (`dsh plugin --profile <name> add github:zouyuanqing/dsh-vision-primitives`).
 *
 * The dynamic sandbox exposes `harness` (defineTool / registerTool) as a
 * closure global; in the bundle form we supply the equivalent facade on top
 * of the official `@deepseek-ai/dsh-tools` helper and `ctx.tools`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BODY = readFileSync(join(__dirname, 'plugin.host.js'), 'utf8')
  .replace(/^\s*return\s*/, '')
const buildPlugin = new Function('ctx', 'harness', `return (${BODY}).apply(ctx)`)

/** Cordis plugin name used by loader diagnostics. */
export const name = 'vision-primitives-native'

/** Services required by the vision tool suite. */
export const inject = ['tools', 'fs', 'subprocess']

/**
 * Harness facade for the bundle form.
 * - defineTool: official DSL normalization + argument validation.
 * - registerTool: forwards to the registry (`ctx.tools`), returning a
 *   disposer so every tool lifetime stays tied to the plugin Fiber.
 * - handle: package-private client RPC is a dynamic-sandbox feature; the
 *   bundle registers no Client half, so a call here is a programming error.
 */
function makeHarness(ctx) {
  return {
    defineTool(def) {
      return defineTool(def)
    },
    registerTool(_sandboxCtx, tool) {
      return ctx.tools.register(tool)
    },
    handle() {
      throw new Error('vision-primitives: harness.handle is only available in the dynamic-plugin sandbox')
    }
  }
}

export function apply(ctx) {
  return buildPlugin(ctx, makeHarness(ctx))
}
