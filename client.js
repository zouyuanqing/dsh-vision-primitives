/**
 * dsh-vision-primitives — browser half: the plugin configuration card shown
 * in 设置 → 插件配置 (the `settings.plugin.item` slot).
 *
 * Mirrors the official web-search card pattern:
 * - apiKey is a credentials-domain literal (ref MIMO_API_KEY); the card only
 *   learns whether one is configured and never rides a response.
 * - baseUrl / model / timeoutMs live in the `vision-primitives` settings
 *   namespace, staged through the settingsScope transport.
 *
 * This file is loaded by dsh-client-modules as `/plugins/dsh-vision-primitives/client.js`
 * (declared via package.json `dsh.client` + `exports["./client"]`), so it
 * uses the platform `__ModuleLoader__` factory format and requires only
 * platform seed words (react, @deepseek-ai/cordis, dsh-client-* services).
 */
window.__ModuleLoader__.load({
  id: 'dsh-vision-primitives',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var react = require('react')
    var h = react.createElement
    var useState = react.useState
    var useEffect = react.useEffect
    var useSyncExternalStore = react.useSyncExternalStore

    /** Namespace of the vision-primitives settings section. */
    var NS = 'vision-primitives'
    /** Credential reference the provider resolves for the MiMo API key. */
    var CRED_REF = 'MIMO_API_KEY'
    /** Injected style tag, claimed by the client module system. */
    var css = ''

    /* ---------- 聊天框图片粘贴 → 路径/证据文本 (paste-to-path) ----------
     * 参考 liustack/modlens 的社区解法, 原生实现:
     *  - capture 阶段 paste 监听, 剪贴板带图片文件时先问 Host
     *    (GET /vision-primitives/paste?model=<label>) 是否接管;
     *  - 视觉模型不被劫持 (原生缩略图附件), 纯文本模型接管:
     *    preventDefault 抑制默认附件摄入 (避免 "model does not support
     *    images" 报错), 图片字节 POST 给 Host, 返回的路径与 MiMo 摘要
     *    作为纯文本插入输入框;
     *  - Host 路由关闭 (pasteToPath=false) 时 GET 返回 404, 客户端完全让行。 */
    function imageFilesOf(event) {
      var items = event.clipboardData && event.clipboardData.items
      if (!items) return []
      var files = []
      for (var i = 0; i < items.length; i++) {
        var item = items[i]
        if (item.kind !== 'file') continue
        var file = item.getAsFile()
        if (file && /^image\//.test(file.type)) files.push(file)
      }
      return files
    }
    function insertText(target, text) {
      var el = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') ? target : document.activeElement
      if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) return
      el.focus()
      var inserted = false
      try {
        inserted = document.execCommand('insertText', false, text)
      } catch (e) {
        inserted = false
      }
      if (!inserted) {
        var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(el, el.value + text)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }
    function uploadOne(file) {
      return file.arrayBuffer().then(function (buffer) {
        return fetch('/vision-primitives/paste?type=' + encodeURIComponent(file.type || 'image/png'), {
          method: 'POST',
          body: buffer
        }).then(function (res) {
          if (!res.ok) {
            return res.json().catch(function () { return {} }).then(function (body) {
              var error = new Error(body.error || 'paste upload failed (' + res.status + ')')
              error.status = res.status
              throw error
            })
          }
          return res.json()
        })
      })
    }
    function currentModelLabel() {
      var buttons = document.querySelectorAll('button[aria-label]')
      for (var i = 0; i < buttons.length; i++) {
        var label = buttons[i].getAttribute('aria-label') || ''
        if (/选择模型|select model|current model/i.test(label)) return label
      }
      return ''
    }
    var pasteRouteAvailable = true
    var pasteVerdicts = {}
    var PASTE_VERDICT_MAX_AGE_MS = 60000
    function refreshPasteVerdict(label) {
      if (!pasteRouteAvailable) return
      var cached = pasteVerdicts[label]
      if (cached && cached.pending) return
      var entry = { pending: true, takeover: cached ? cached.takeover : false, at: cached ? cached.at : 0 }
      pasteVerdicts[label] = entry
      fetch('/vision-primitives/paste?model=' + encodeURIComponent(label))
        .then(function (res) {
          if (res.status === 404) {
            pasteRouteAvailable = false
            entry.pending = false
            return null
          }
          if (!res.ok) throw new Error('policy ' + res.status)
          return res.json()
        })
        .then(function (body) {
          entry.pending = false
          if (body) {
            entry.takeover = body.takeover === true
            entry.at = Date.now()
          }
        })
        .catch(function () {
          entry.pending = false
        })
    }
    function onPasteFocusIn() {
      refreshPasteVerdict(currentModelLabel())
    }
    function onPaste(event) {
      if (!pasteRouteAvailable) return
      var files = imageFilesOf(event)
      if (files.length === 0) return
      var label = currentModelLabel()
      var cached = pasteVerdicts[label]
      refreshPasteVerdict(label)
      if (!cached || cached.at === 0 || cached.takeover !== true || Date.now() - cached.at > PASTE_VERDICT_MAX_AGE_MS) return
      event.preventDefault()
      event.stopImmediatePropagation()
      var target = event.target
      Promise.all(files.map(uploadOne))
        .then(function (results) {
          var parts = []
          for (var i = 0; i < results.length; i++) {
            var r = results[i]
            if (!r || !r.path) continue
            var line = r.path
            var a = r.analysis
            if (a && a.ok) {
              if (a.caption) line += '\n【图片分析】' + a.caption
              if (a.elements && a.elements.length) {
                var els = []
                for (var j = 0; j < a.elements.length; j++) {
                  var el = a.elements[j]
                  var s = el.label
                  if (el.text) s += '「' + el.text + '」'
                  if (el.grid_cell) s += ' @格子' + el.grid_cell
                  els.push(s)
                }
                line += '\n关键元素: ' + els.join('; ')
              }
            }
            parts.push(line)
          }
          if (parts.length) insertText(target, parts.join('\n') + '\n')
        })
        .catch(function (error) {
          if (error && error.status === 404) {
            pasteRouteAvailable = false
            pasteVerdicts = {}
          }
          console.error('[vision-primitives] paste-to-path failed: ' + (error && error.message ? error.message : error))
        })
    }

    function field(id, label, hint, value, onChange, opts) {
      return h('label', { className: 'vpr-field', key: id }, [
        h('span', { className: 'vpr-label' }, label),
        h('input', {
          className: 'vpr-input',
          type: opts && opts.secret ? 'password' : 'text',
          value: value == null ? '' : String(value),
          placeholder: opts && opts.placeholder ? opts.placeholder : '',
          disabled: opts && opts.disabled,
          onChange: (e) => onChange(e.target.value)
        }),
        hint ? h('span', { className: 'vpr-hint' }, hint) : null
      ])
    }

    /**
     * The card: staged form over the settings scope plus the credential
     * literal. One 保存 button commits everything the card shows.
     */
    function VprCard(props) {
      var t = props.t
      var snapshot = useSyncExternalStore(props.subscribe, props.getSnapshot)
      var value = snapshot && snapshot.value ? snapshot.value : {}
      var base = snapshot && snapshot.base ? snapshot.base : {}
      var [baseUrl, setBaseUrl] = useState(value.baseUrl != null ? value.baseUrl : (base.baseUrl != null ? base.baseUrl : ''))
      var [model, setModel] = useState(value.model != null ? value.model : (base.model != null ? base.model : ''))
      var [timeoutMs, setTimeoutMs] = useState(value.timeoutMs != null ? value.timeoutMs : (base.timeoutMs != null ? base.timeoutMs : 300000))
      var [apiKey, setApiKey] = useState('')
      var [configured, setConfigured] = useState(props.credentialConfigured)
      var [saving, setSaving] = useState(false)
      var [message, setMessage] = useState('')
      var [pasteToPath, setPasteToPath] = useState(value.pasteToPath !== false)
      var [autoDescribe, setAutoDescribe] = useState(value.autoDescribe !== false)

      useEffect(() => {
        if (value.baseUrl != null && value.baseUrl !== baseUrl) setBaseUrl(value.baseUrl)
        if (value.model != null && value.model !== model) setModel(value.model)
        if (value.timeoutMs != null && value.timeoutMs !== timeoutMs) setTimeoutMs(value.timeoutMs)
        if (typeof value.pasteToPath === 'boolean' && value.pasteToPath !== pasteToPath) setPasteToPath(value.pasteToPath)
        if (typeof value.autoDescribe === 'boolean' && value.autoDescribe !== autoDescribe) setAutoDescribe(value.autoDescribe)
        setConfigured(props.credentialConfigured)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [snapshot, props.credentialConfigured])

      var writable = snapshot ? snapshot.writable !== false : true

      function save() {
        if (!writable) return
        setSaving(true)
        setMessage('')
        props.save({
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          timeoutMs: Number(timeoutMs),
          pasteToPath: pasteToPath,
          autoDescribe: autoDescribe
        }).then((ok) => {
          setApiKey('')
          if (ok.configured != null) setConfigured(ok.configured)
          setMessage(ok.ok ? t('saved') : t('saveFailed'))
          setSaving(false)
        })
      }

      function checkbox(id, label, hint, checked, onChange) {
        return h('label', { className: 'vpr-check', key: id }, [
          h('input', {
            type: 'checkbox',
            checked: checked,
            onChange: (e) => onChange(e.target.checked)
          }),
          h('span', { className: 'vpr-label' }, label),
          hint ? h('span', { className: 'vpr-hint' }, hint) : null
        ])
      }

      return h('div', { className: 'vpr-card' }, [
        h('div', { className: 'vpr-title' }, t('title')),
        h('div', { className: 'vpr-desc' }, t('description')),
        field('apiKey', t('apiKey'), configured ? t('apiKeySet') : t('apiKeyUnset'), apiKey, setApiKey, { secret: true, placeholder: configured ? '••••••••' : '' }),
        field('baseUrl', t('baseUrl'), t('baseUrlHint'), baseUrl, setBaseUrl),
        field('model', t('model'), t('modelHint'), model, setModel),
        field('timeoutMs', t('timeoutMs'), t('timeoutMsHint'), String(timeoutMs), setTimeoutMs),
        checkbox('pasteToPath', t('pasteToPath'), t('pasteToPathHint'), pasteToPath, setPasteToPath),
        checkbox('autoDescribe', t('autoDescribe'), t('autoDescribeHint'), autoDescribe, setAutoDescribe),
        h('div', { className: 'vpr-actions' }, [
          h('button', { className: 'vpr-button', disabled: saving || !writable, onClick: save }, saving ? t('saving') : t('save')),
          message ? h('span', { className: 'vpr-message' }, message) : null
        ])
      ])
    }

    /** Bind the settings scope and the credentials wire onto the card. */
    function CardController(ctx, scope, api) {
      this.ctx = ctx
      this.scope = scope
      this.api = api
      this.credentialConfigured = false
      var self = this
      scope.subscribe(function () {
        self.refreshCredential()
      })
      this.refreshCredential()
    }
    CardController.prototype.refreshCredential = function () {
      var self = this
      this.api.credentials.describe({ refs: [CRED_REF] }).then(function (response) {
        if (!response.result.ok) return
        var view = response.result.value.credentials[CRED_REF]
        var next = view ? view.configured === true : false
        if (next !== self.credentialConfigured) self.credentialConfigured = next
      }).catch(function () {})
    }
    CardController.prototype.save = function (patch) {
      var self = this
      var writes = []
      if (patch.apiKey && patch.apiKey.length > 0) {
        writes.push(this.api.credentials.set({ ref: CRED_REF, value: patch.apiKey }).then(function (r) {
          return r && r.result ? r.result.ok : false
        }).catch(function () { return false }))
      }
      if (patch.baseUrl && patch.baseUrl.length > 0) writes.push(this.scope.set('baseUrl', patch.baseUrl))
      if (patch.model && patch.model.length > 0) writes.push(this.scope.set('model', patch.model))
      if (Number.isFinite(patch.timeoutMs) && patch.timeoutMs > 0) writes.push(this.scope.set('timeoutMs', patch.timeoutMs))
      if (typeof patch.pasteToPath === 'boolean') writes.push(this.scope.set('pasteToPath', patch.pasteToPath))
      if (typeof patch.autoDescribe === 'boolean') writes.push(this.scope.set('autoDescribe', patch.autoDescribe))
      if (writes.length === 0) return Promise.resolve({ ok: true, configured: this.credentialConfigured })
      return Promise.all(writes).then(function () {
        self.refreshCredential()
        return { ok: true, configured: self.credentialConfigured }
      }).catch(function () {
        return { ok: false, configured: self.credentialConfigured }
      })
    }
    CardController.prototype.inject = function () {
      var self = this
      return {
        hooks: { vprCard: {
          getSnapshot: function () { return self.scope.getSnapshot() },
          subscribe: function (listener) { return self.scope.subscribe(listener) }
        } },
        subscribe: function (listener) { return self.scope.subscribe(listener) },
        getSnapshot: function () { return self.scope.getSnapshot() },
        credentialConfigured: function () { return self.credentialConfigured },
        save: function (patch) { return self.save(patch) }
      }
    }

    /** Required services (cordis fiber inject). */
    var inject = [
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-api-remotes'
    ]

    /** Mount the configuration card into the plugins settings section. */
    function apply(ctx) {
      var api = ctx.get('connection').api
      var t = ctx.locale.bind(NS)
      ctx.effect(function () {
        return ctx.locale.register(NS, {
          zh: {
            title: 'Vision Primitives(视觉交互推理)',
            description: 'MiMo 后端配置:未填 API Key 时仅本地视觉原语(网格/缩放/标注/测量/差分/颜色/OCR)可用;describe/locate 与 mimo 模型路由需要 Key。',
            apiKey: 'API Key(MiMo)',
            apiKeySet: '已配置',
            apiKeyUnset: '未配置',
            baseUrl: 'Base URL',
            baseUrlHint: 'MiMo OpenAI 兼容端点,默认 https://api.xiaomimimo.com/v1',
            model: '模型',
            modelHint: '默认 mimo-v2.5',
            timeoutMs: '超时(毫秒)',
            timeoutMsHint: '单次 MiMo 调用超时,默认 300000',
            pasteToPath: '纯文本模型贴图接管',
            pasteToPathHint: '开启后,纯文本模型下聊天框粘贴图片自动转为"路径 + 内容摘要"文本(社区 paste-to-path 方案)',
            autoDescribe: '粘贴自动描述',
            autoDescribeHint: '粘贴图片后用 MiMo 生成内容摘要插入输入框(需 API Key)',
            save: '保存',
            saving: '保存中…',
            saved: '已保存',
            saveFailed: '保存失败'
          },
          en: {
            title: 'Vision Primitives (visual reasoning)',
            description: 'MiMo backend settings: without an API key only the local vision primitives (grid/zoom/annotate/measure/diff/color/OCR) work; describe/locate and the mimo model route need a key.',
            apiKey: 'API Key (MiMo)',
            apiKeySet: 'Configured',
            apiKeyUnset: 'Not configured',
            baseUrl: 'Base URL',
            baseUrlHint: 'MiMo OpenAI-compatible endpoint, default https://api.xiaomimimo.com/v1',
            model: 'Model',
            modelHint: 'Default mimo-v2.5',
            timeoutMs: 'Timeout (ms)',
            timeoutMsHint: 'Per-call timeout, default 300000',
            pasteToPath: 'Paste takeover for text-only models',
            pasteToPathHint: 'When on, pasting an image with a text-only model inserts "path + content summary" text instead (paste-to-path)',
            autoDescribe: 'Auto-describe pastes',
            autoDescribeHint: 'Generate a MiMo content summary for pasted images (needs API key)',
            save: 'Save',
            saving: 'Saving…',
            saved: 'Saved',
            saveFailed: 'Save failed'
          }
        })
      })
      var scope = ctx.settingsScope.bind({ namespace: NS })
      var controller = new CardController(ctx, scope, api)
      var registered = false
      function renderCard() {
        var hooks = controller.inject()
        return h(VprCard, {
          t: t,
          subscribe: hooks.subscribe,
          getSnapshot: hooks.getSnapshot,
          credentialConfigured: hooks.credentialConfigured(),
          save: hooks.save
        })
      }
      ctx.slots.inject('settings.plugin.item', function* () {
        if (registered) return
        registered = true
        yield ctx.slots.register({
          name: 'settings.plugin.item',
          id: 'vision-primitives',
          order: 30,
          locale: NS,
          inject: function () {
            return {
              hooks: { vprCard: {
                getSnapshot: function () { return scope.getSnapshot() },
                subscribe: function (listener) { return scope.subscribe(listener) }
              } },
              subscribe: function (listener) { return scope.subscribe(listener) },
              getSnapshot: function () { return scope.getSnapshot() },
              credentialConfigured: function () { return controller.credentialConfigured },
              save: function (patch) { return controller.save(patch) }
            }
          }
        }, renderCard)
      })
      ctx.effect(function () {
        if (typeof document === 'undefined') return function () {}
        if (!css) {
          css = '.vpr-card{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--border-color,#333);border-radius:8px;background:var(--surface-color,transparent)}' +
            '.vpr-title{font-weight:600;font-size:14px}.vpr-desc{font-size:12px;opacity:.75}.vpr-field{display:flex;flex-direction:column;gap:4px;font-size:13px}' +
            '.vpr-label{opacity:.9}.vpr-input{padding:6px 8px;border:1px solid var(--border-color,#444);border-radius:6px;background:var(--input-background,#1a1a1a);color:inherit;font:inherit}' +
            '.vpr-hint{font-size:11px;opacity:.6}.vpr-check{display:flex;align-items:center;gap:8px;font-size:13px}.vpr-check .vpr-hint{display:block;width:100%}' +
            '.vpr-actions{display:flex;align-items:center;gap:10px;margin-top:4px}' +
            '.vpr-button{padding:6px 14px;border-radius:6px;border:1px solid var(--border-color,#444);background:var(--accent-color,#2d6cdf);color:#fff;cursor:pointer;font:inherit}' +
            '.vpr-button:disabled{opacity:.5;cursor:default}.vpr-message{font-size:12px;opacity:.8}'
          var el = document.createElement('style')
          el.textContent = css
          document.head.append(el)
        }
        return function () {}
      })
      // paste-to-path: capture-phase listeners, removed on plugin disposal.
      ctx.effect(function () {
        if (typeof document === 'undefined') return function () {}
        document.addEventListener('paste', onPaste, true)
        document.addEventListener('focusin', onPasteFocusIn, true)
        return function () {
          document.removeEventListener('paste', onPaste, true)
          document.removeEventListener('focusin', onPasteFocusIn, true)
        }
      }, 'vision-primitives: paste-to-path listener')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
