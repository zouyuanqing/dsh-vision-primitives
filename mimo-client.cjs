// MiMo v2.5 OpenAI 兼容客户端 (经 DSH subprocess 服务由插件派生的 node 子进程)
// 用法: node mimo-client.cjs <stream|json> <reqFile>
// 请求文件 JSON: { url, apiKey, body, timeoutMs }
// 输出(每行一个 JSON 事件): {type:'data',json} / {type:'done',data?} / {type:'error',status?,message}
// 注意: 本文件刻意不使用任何反斜杠转义序列, 以避免嵌入模板字符串时的转义层级问题
const fs = require('fs')
const [mode, reqFile] = process.argv.slice(2)
const req = JSON.parse(fs.readFileSync(reqFile, 'utf8').replace(String.fromCharCode(65279), ''))
const streamMode = mode === 'stream'
const NL = String.fromCharCode(10)
const out = (obj) => process.stdout.write(JSON.stringify(obj) + NL)
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(new Error('mimo-client timeout')), req.timeoutMs || 300000)
fetch(req.url, {
  method: 'POST',
  headers: {
    'authorization': 'Bearer ' + req.apiKey,
    'content-type': 'application/json',
    'accept': streamMode ? 'text/event-stream' : 'application/json'
  },
  body: JSON.stringify(req.body),
  signal: controller.signal
}).then(async (res) => {
  if (!res.ok) {
    let t = ''
    try { t = await res.text() } catch (e) {}
    out({ type: 'error', status: res.status, message: t.slice(0, 2000) })
    process.exit(1)
  }
  if (!streamMode) {
    const data = await res.json()
    out({ type: 'done', data })
    return
  }
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true })
    let nl
    while ((nl = buf.indexOf(NL)) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') {
        out({ type: 'done' })
        return
      }
      out({ type: 'data', json: payload })
    }
  }
}).catch((e) => {
  out({ type: 'error', message: String((e && e.message) || e) })
  process.exit(1)
}).finally(() => clearTimeout(timer))
