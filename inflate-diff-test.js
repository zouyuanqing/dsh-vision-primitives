// 差分对拍: 我的 inflateZlib vs Node zlib.inflateSync, 定位第一个分歧
const fs = require('fs')
const zlib = require('zlib')

function loadKernel(src) {
  const start = src.indexOf('const B64CHARS')
  const end = src.indexOf('/* --------------------------- 几何 / 绘制')
  const code = src.slice(start, end)
  const factory = new Function(code + '\n;return { inflateZlib }')
  return factory()
}

const src = fs.readFileSync('C:/Users/zyq/Documents/dph-p1/vision-primitives-native/plugin.host.js', 'utf8')
const { inflateZlib } = loadKernel(src)

// 构造多种压力样本
const samples = []
samples.push(['short-ascii', Buffer.from('hello world, hello world, hello world!', 'utf8')])
samples.push(['repeat-500', Buffer.from('abcabcabcabcabcabcabcabc', 'utf8').subarray(0, 0)]) // placeholder
samples.push(['random-64k', require('crypto').randomBytes(65536)])
samples.push(['lorem-1k', Buffer.from(('The quick brown fox jumps over the lazy dog. ').repeat(30), 'utf8')])
samples.push(['repeat-8k', Buffer.from('ABCDEFGH'.repeat(1024), 'utf8')])
samples.push(['zeros-32k', Buffer.alloc(32768, 0)])
samples.push(['pattern-16k', Buffer.from(Array.from({ length: 16384 }, (_, i) => String.fromCharCode((i * 7) % 251)), 'binary')])

let pass = 0
let fail = 0
for (const [name, buf] of samples) {
  const zs = zlib.deflateSync(buf, { level: 6 }) // zlib 流 (带 2 字节头)
  const ref = zlib.inflateSync(zs)
  try {
    const mine = inflateZlib(new Uint8Array(zs))
    let ok = mine.length === ref.length
    if (ok) {
      for (let i = 0; i < mine.length; i++) {
        if (mine[i] !== ref[i]) { ok = false; console.log(`[${name}] first byte diff at ${i}: mine=${mine[i]} ref=${ref[i]}`); break }
      }
    } else {
      console.log(`[${name}] length diff: mine=${mine.length} ref=${ref.length}`)
    }
    if (ok) { pass++; console.log(`[${name}] OK (${buf.length} -> ${zs.length} bytes)`) }
    else fail++
  } catch (e) {
    fail++
    console.log(`[${name}] THROW: ${e.message}`)
  }
}
console.log(`pass=${pass} fail=${fail}`)
