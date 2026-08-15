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
 *
 * Configuration surface: this package declares the `vision-primitives`
 * settings namespace (WebUI 设置 → 插件配置). Resolution order is
 * settings user section → this entry's composition config (base) → schema
 * defaults. The MiMo API key is a `role('secret')` field; it is never
 * written to source and never rides a wire unredacted.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BODY = readFileSync(join(__dirname, 'plugin.host.js'), 'utf8')
  .replace(/^\s*return\s*/, '')
const buildPlugin = new Function('ctx', 'harness', `return (${BODY}).apply(ctx)`)

/** Cordis plugin name used by loader diagnostics. */
export const name = 'vision-primitives-native'

/** Services required by the vision tool suite. */
export const inject = ['tools', 'fs', 'subprocess']

/** Settings namespace carrying this plugin's endpoint, model, and key. */
const NS = settingsNamespace('vision-primitives')

/** Plugin configuration schema (also the settings namespace schema). */
export const Config = z.object({
  apiKey: z.string().role('secret').default(''),
  baseUrl: z.string().default('https://api.xiaomimimo.com/v1'),
  model: z.string().default('mimo-v2.5'),
  timeoutMs: z.number().step(1).min(1000).default(300000),
  pasteToPath: z.boolean().default(false),
  autoDescribe: z.boolean().default(false)
})

/**
 * Harness facade for the bundle form.
 * - defineTool: official DSL normalization + argument validation.
 * - registerTool: forwards to the registry (`ctx.tools`), returning a
 *   disposer so every tool lifetime stays tied to the plugin Fiber.
 * - vprSettings: installs the `vision-primitives` settings namespace so the
 *   WebUI settings surface can edit apiKey / baseUrl / model / timeoutMs.
 * - handle: package-private client RPC is a dynamic-sandbox feature; the
 *   bundle's client half uses the settings transport instead.
 */
function makeHarness(ctx, config) {
  return {
    defineTool(def) {
      return defineTool(def)
    },
    registerTool(_sandboxCtx, tool) {
      return ctx.tools.register(tool)
    },
    vprSettings: {
      install(pluginCtx, setSource) {
        installSettingsSection(pluginCtx, NS, Config, config, {
          setSource: (thunk) => setSource(thunk),
          onChange: () => {}
        })
      }
    },
    handle() {
      throw new Error('vision-primitives: harness.handle is only available in the dynamic-plugin sandbox')
    }
  }
}

export function apply(ctx, config) {
  return buildPlugin(ctx, makeHarness(ctx, config))
}
