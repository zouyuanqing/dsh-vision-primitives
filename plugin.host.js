return {
  name: 'vision-primitives-native',
  inject: ['fs', 'subprocess'],
  apply(ctx, config) {
    /* =========================================================================
     * 原生交互式视觉推理插件 (vision-primitives, native DeepSeek Harness)
     * 参考: https://github.com/zouyuanqing/vision-primitives-mcp
     *
     * 架构:
     *  - 视觉推理内核 100% 在 DSH Host Node.js 运行时内以纯 JS 执行:
     *    PNG 编解码 (zlib inflate + stored-deflate, 零依赖)、裁剪、最近邻缩放、
     *    5x7 点阵字体、SOM 编号网格、标注绘制、颜色分割连通域、帧差分、
     *    坐标映射链与会话状态机。
     *  - 智能体即视觉模型: 插件产出图片路径与确定性坐标数学, Harness 多模态
     *    智能体用 read_image 看图决策, 插件负责把"模糊感知"换算成"精确像素"。
     *  - 最小 OS 边界: 仅截屏/OCR/二进制落盘 3 类走 Host 原生 subprocess
     *    服务调用 Windows PowerShell 系统脚本 (harness 自身管理的进程服务,
     *    非外部 MCP 服务器); 不含桌面键鼠控制。
     *
     * 典型工作流 (交互式图形推理协议):
     *   vision_capture(screen|file) -> vision_grid -> read_image 选格 ->
     *   vision_resolve(cell) 得精确坐标 -> vision_zoom 局部放大精修 ->
     *   vision_annotate / vision_measure / vision_ocr / vision_find_color 验证 ->
     *   vision_capture + vision_diff 变化检测
     * ========================================================================= */

    const fsSvc = ctx.get('fs')
    const spSvc = ctx.get('subprocess')
    if (fsSvc === undefined || spSvc === undefined) return

    const policy = ctx.get('sandboxPolicy')
    const workspaceRoot = (policy && typeof policy.workspaceRoot === 'string' && policy.workspaceRoot.length > 0)
      ? policy.workspaceRoot
      : '.'
    const storeDir = `${workspaceRoot}/.vispri`
    const framesDir = `${storeDir}/frames`
    const helperPath = `${storeDir}/vision-helper.ps1`

    /* ------------------------------ 基础工具 ------------------------------ */

    function clampInt(v, lo, hi, dflt) {
      if (v === undefined || v === null || typeof v !== 'number' || !Number.isFinite(v)) return dflt
      return Math.max(lo, Math.min(hi, Math.round(v)))
    }

    const B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    function b64encode(u8) {
      let out = ''
      for (let i = 0; i < u8.length; i += 3) {
        const a = u8[i]
        const b = i + 1 < u8.length ? u8[i + 1] : 0
        const c = i + 2 < u8.length ? u8[i + 2] : 0
        out += B64CHARS[a >> 2]
        out += B64CHARS[((a & 3) << 4) | (b >> 4)]
        out += i + 1 < u8.length ? B64CHARS[((b & 15) << 2) | (c >> 6)] : '='
        out += i + 2 < u8.length ? B64CHARS[c & 63] : '='
      }
      return out
    }

    const CRC_TABLE = (() => {
      const t = new Uint32Array(256)
      for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
        t[n] = c >>> 0
      }
      return t
    })()
    function crc32(b, s, e) {
      let c = 0xFFFFFFFF
      for (let i = s; i < e; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8)
      return (c ^ 0xFFFFFFFF) >>> 0
    }
    function adler32(d) {
      let a = 1
      let b = 0
      let i = 0
      while (i < d.length) {
        const n = Math.min(5552, d.length - i)
        for (let j = 0; j < n; j++) {
          a += d[i + j]
          b += a
        }
        a %= 65521
        b %= 65521
        i += n
      }
      return ((b << 16) | a) >>> 0
    }
    function readU32(b, i) {
      return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
    }
    function writeU32(b, i, v) {
      b[i] = (v >>> 24) & 255
      b[i + 1] = (v >>> 16) & 255
      b[i + 2] = (v >>> 8) & 255
      b[i + 3] = v & 255
    }

    /* ------------------------- inflate (RFC1951) ------------------------- */

    function inflateZlib(src) {
      if (src.length < 6) throw new Error('zlib: stream too short')
      let pos = 2
      let bitBuf = 0
      let bitCnt = 0
      let out = new Uint8Array(1 << 16)
      let olen = 0
      function ensure(n) {
        if (olen + n <= out.length) return
        let cap = out.length * 2
        while (cap < olen + n) cap *= 2
        const next = new Uint8Array(cap)
        next.set(out.subarray(0, olen))
        out = next
      }
      function putByte(bv) { ensure(1); out[olen++] = bv }
      function putBytes(seg) { ensure(seg.length); out.set(seg, olen); olen += seg.length }
      function rb(n) {
        while (bitCnt < n) {
          if (pos >= src.length) throw new Error('zlib: unexpected end of stream')
          bitBuf |= src[pos++] << bitCnt
          bitCnt += 8
        }
        const v = bitBuf & ((1 << n) - 1)
        bitBuf >>>= n
        bitCnt -= n
        return v
      }
      function align() { bitBuf = 0; bitCnt = 0 }
      function buildTable(lens, maxBits) {
        const counts = new Int32Array(maxBits + 1)
        for (let i = 0; i < lens.length; i++) {
          const l = lens[i]
          if (l > 0) counts[l]++
        }
        const base = new Int32Array(maxBits + 1)
        let offs = 0
        for (let b = 1; b <= maxBits; b++) {
          base[b] = offs
          offs += counts[b]
        }
        const syms = new Int32Array(offs)
        const cursor = base.slice()
        for (let i = 0; i < lens.length; i++) {
          const l = lens[i]
          if (l > 0) syms[cursor[l]++] = i
        }
        return { counts, base, syms }
      }
      function decodeSym(t, maxBits) {
        let code = 0
        let first = 0
        let index = 0
        for (let len = 1; len <= maxBits; len++) {
          code |= rb(1)
          const count = t.counts[len]
          if (code - first < count) return t.syms[t.base[len] + (code - first)]
          index += count
          first += count
          first <<= 1
          code <<= 1
        }
        throw new Error('zlib: invalid huffman code')
      }
      const fixedLitLens = new Array(288)
      for (let i = 0; i <= 143; i++) fixedLitLens[i] = 8
      for (let i = 144; i <= 255; i++) fixedLitLens[i] = 9
      for (let i = 256; i <= 279; i++) fixedLitLens[i] = 7
      for (let i = 280; i <= 287; i++) fixedLitLens[i] = 8
      const fixedDistLens = new Array(30).fill(5)
      const FIXED_LIT = buildTable(fixedLitLens, 9)
      const FIXED_DIST = buildTable(fixedDistLens, 5)
      const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
      const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
      function distFromSym(sym) {
        if (sym < 4) return sym + 1
        if (sym > 29) throw new Error('zlib: invalid distance code')
        const extra = (sym >> 1) - 1
        const base = ((2 + (sym & 1)) << extra) + 1
        return base + rb(extra)
      }
      for (;;) {
        const bfinal = rb(1)
        const btype = rb(2)
        if (btype === 0) {
          align()
          if (pos + 4 > src.length) throw new Error('zlib: truncated stored block')
          const len = src[pos] | (src[pos + 1] << 8)
          pos += 4
          if (pos + len > src.length) throw new Error('zlib: truncated stored data')
          putBytes(src.subarray(pos, pos + len))
          pos += len
        } else if (btype === 1 || btype === 2) {
          let litT = FIXED_LIT
          let distT = FIXED_DIST
          let litMax = 9
          let distMax = 5
          if (btype === 2) {
            const hlit = rb(5) + 257
            const hdist = rb(5) + 1
            const hclen = rb(4) + 4
            const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]
            const clLens = new Array(19).fill(0)
            for (let i = 0; i < hclen; i++) clLens[ORDER[i]] = rb(3)
            const clT = buildTable(clLens, 7)
            const lens = new Array(hlit + hdist)
            let i = 0
            while (i < hlit + hdist) {
              const s = decodeSym(clT, 7)
              if (s < 16) {
                lens[i++] = s
              } else if (s === 16) {
                if (i === 0) throw new Error('zlib: repeat with no previous length')
                const rep = 3 + rb(2)
                const prev = lens[i - 1]
                for (let k = 0; k < rep && i < hlit + hdist; k++) lens[i++] = prev
              } else if (s === 17) {
                const rep = 3 + rb(3)
                for (let k = 0; k < rep && i < hlit + hdist; k++) lens[i++] = 0
              } else {
                const rep = 11 + rb(7)
                for (let k = 0; k < rep && i < hlit + hdist; k++) lens[i++] = 0
              }
            }
            litT = buildTable(lens.slice(0, hlit), 15)
            distT = buildTable(lens.slice(hlit), 15)
            litMax = 15
            distMax = 15
          }
          for (;;) {
            const s = decodeSym(litT, litMax)
            if (s === 256) break
            if (s < 256) {
              putByte(s)
            } else {
              const li = s - 257
              if (li > 28) throw new Error('zlib: invalid length code')
              const len = LEN_BASE[li] + rb(LEN_EXTRA[li])
              const ds = decodeSym(distT, distMax)
              const dist = distFromSym(ds)
              if (dist > olen) throw new Error('zlib: distance too far back')
              ensure(len)
              let p = olen - dist
              for (let k = 0; k < len; k++) out[olen++] = out[p++]
            }
          }
        } else {
          throw new Error('zlib: invalid block type')
        }
        if (bfinal) break
      }
      return out.subarray(0, olen)
    }

    /* ------------------------- PNG 解码 / 编码 ------------------------- */

    function decodePng(buf) {
      if (buf.length < 8 || buf[0] !== 137 || buf[1] !== 80 || buf[2] !== 78 || buf[3] !== 71) {
        throw new Error('not a PNG file')
      }
      let pos = 8
      let w = 0
      let h = 0
      let bd = 0
      let ct = 0
      let interlace = 0
      let palette = null
      const idat = []
      while (pos + 8 <= buf.length) {
        const len = readU32(buf, pos)
        const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7])
        const start = pos + 8
        if (type === 'IHDR') {
          w = readU32(buf, start)
          h = readU32(buf, start + 4)
          bd = buf[start + 8]
          ct = buf[start + 9]
          interlace = buf[start + 12]
        } else if (type === 'PLTE') {
          palette = buf.subarray(start, start + len)
        } else if (type === 'IDAT') {
          idat.push(buf.subarray(start, start + len))
        } else if (type === 'IEND') {
          break
        }
        pos = start + len + 4
      }
      if (w <= 0 || h <= 0 || w > 65536 || h > 65536) throw new Error('PNG: bad dimensions')
      if (interlace !== 0) throw new Error('PNG: interlaced images are not supported')
      if (bd !== 8 && bd !== 16) throw new Error('PNG: only bit depth 8/16 supported')
      let total = 0
      for (const c of idat) total += c.length
      const z = new Uint8Array(total)
      let o = 0
      for (const c of idat) { z.set(c, o); o += c.length }
      const raw = inflateZlib(z)
      const ch = ct === 0 ? 1 : ct === 2 ? 3 : ct === 3 ? 1 : ct === 4 ? 2 : ct === 6 ? 4 : 0
      if (ch === 0) throw new Error('PNG: unsupported color type ' + ct)
      const bytesPP = ch * (bd === 16 ? 2 : 1)
      const stride = w * bytesPP
      if (raw.length < (stride + 1) * h) throw new Error('PNG: truncated pixel data')
      const out = new Uint8Array(w * h * 4)
      let rp = 0
      const row = new Uint8Array(stride)
      const prev = new Uint8Array(stride)
      for (let y = 0; y < h; y++) {
        const f = raw[rp++]
        row.set(raw.subarray(rp, rp + stride))
        rp += stride
        if (f === 1) {
          for (let i = 0; i < stride; i++) {
            const a = i >= bytesPP ? row[i - bytesPP] : 0
            row[i] = (row[i] + a) & 255
          }
        } else if (f === 2) {
          for (let i = 0; i < stride; i++) row[i] = (row[i] + prev[i]) & 255
        } else if (f === 3) {
          for (let i = 0; i < stride; i++) {
            const a = i >= bytesPP ? row[i - bytesPP] : 0
            const b = prev[i]
            row[i] = (row[i] + ((a + b) >> 1)) & 255
          }
        } else if (f === 4) {
          for (let i = 0; i < stride; i++) {
            const a = i >= bytesPP ? row[i - bytesPP] : 0
            const b = prev[i]
            const c = i >= bytesPP ? prev[i - bytesPP] : 0
            const p = a + b - c
            const pa = Math.abs(p - a)
            const pb = Math.abs(p - b)
            const pc = Math.abs(p - c)
            const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
            row[i] = (row[i] + pr) & 255
          }
        } else if (f !== 0) {
          throw new Error('PNG: unknown filter ' + f)
        }
        prev.set(row)
        for (let x = 0; x < w; x++) {
          let r = 0
          let g = 0
          let b = 0
          let a = 255
          if (bd === 8) {
            if (ct === 0) { const v = row[x]; r = g = b = v }
            else if (ct === 2) { r = row[x * 3]; g = row[x * 3 + 1]; b = row[x * 3 + 2] }
            else if (ct === 4) { const v = row[x * 2]; r = g = b = v; a = row[x * 2 + 1] }
            else if (ct === 6) { r = row[x * 4]; g = row[x * 4 + 1]; b = row[x * 4 + 2]; a = row[x * 4 + 3] }
          } else {
            if (ct === 0) { const v = row[x * 2]; r = g = b = v }
            else if (ct === 2) { r = row[x * 6]; g = row[x * 6 + 2]; b = row[x * 6 + 4] }
            else if (ct === 4) { const v = row[x * 4]; r = g = b = v; a = row[x * 4 + 2] }
            else if (ct === 6) { r = row[x * 8]; g = row[x * 8 + 2]; b = row[x * 8 + 4]; a = row[x * 8 + 6] }
          }
          if (ct === 3) {
            const idx = bd === 8 ? row[x] : row[x * 2]
            if (!palette || idx * 3 + 2 >= palette.length) throw new Error('PNG: bad palette index')
            r = palette[idx * 3]
            g = palette[idx * 3 + 1]
            b = palette[idx * 3 + 2]
          }
          const d = (y * w + x) * 4
          if (a < 255) {
            const af = a / 255
            out[d] = Math.round(r * af + 255 * (1 - af))
            out[d + 1] = Math.round(g * af + 255 * (1 - af))
            out[d + 2] = Math.round(b * af + 255 * (1 - af))
          } else {
            out[d] = r
            out[d + 1] = g
            out[d + 2] = b
          }
          out[d + 3] = 255
        }
      }
      return { width: w, height: h, data: out }
    }

    function zlibStore(data) {
      const blocks = Math.ceil(data.length / 65535)
      const out = new Uint8Array(2 + blocks * 5 + data.length + 4)
      out[0] = 0x78
      out[1] = 0x01
      let p = 2
      let d = 0
      for (let blk = 0; blk < blocks; blk++) {
        const final = blk === blocks - 1 ? 1 : 0
        const len = Math.min(65535, data.length - d)
        out[p++] = final
        out[p++] = len & 255
        out[p++] = (len >> 8) & 255
        out[p++] = (~len) & 255
        out[p++] = ((~len) >> 8) & 255
        out.set(data.subarray(d, d + len), p)
        p += len
        d += len
      }
      const ad = adler32(data)
      out[p++] = (ad >>> 24) & 255
      out[p++] = (ad >>> 16) & 255
      out[p++] = (ad >>> 8) & 255
      out[p++] = ad & 255
      return out
    }

    function encodePng(w, h, data) {
      const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      const chunk = (type, payload) => {
        const len = payload.length
        const c = new Uint8Array(len + 12)
        writeU32(c, 0, len)
        for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i)
        c.set(payload, 8)
        writeU32(c, 8 + len, crc32(c, 4, 8 + len))
        return c
      }
      const ihdr = new Uint8Array(13)
      writeU32(ihdr, 0, w)
      writeU32(ihdr, 4, h)
      ihdr[8] = 8
      ihdr[9] = 6
      const stride = w * 4
      const raw = new Uint8Array((stride + 1) * h)
      let p = 0
      for (let y = 0; y < h; y++) {
        raw[p++] = 0
        raw.set(data.subarray(y * stride, (y + 1) * stride), p)
        p += stride
      }
      const idat = zlibStore(raw)
      const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]
      let total = 0
      for (const x of parts) total += x.length
      const out = new Uint8Array(total)
      let o = 0
      for (const x of parts) { out.set(x, o); o += x.length }
      return out
    }

    /* --------------------------- 几何 / 绘制 --------------------------- */

    function clampBox(box, w, h) {
      const x1 = Math.max(0, Math.min(w - 1, Math.round(box[0])))
      const y1 = Math.max(0, Math.min(h - 1, Math.round(box[1])))
      const x2 = Math.max(x1 + 1, Math.min(w, Math.round(box[2])))
      const y2 = Math.max(y1 + 1, Math.min(h, Math.round(box[3])))
      return [x1, y1, x2, y2]
    }
    function crop(img, box) {
      const [x1, y1, x2, y2] = box
      const w = x2 - x1
      const h = y2 - y1
      const out = new Uint8Array(w * h * 4)
      for (let y = 0; y < h; y++) {
        const s = ((y1 + y) * img.width + x1) * 4
        out.set(img.data.subarray(s, s + w * 4), y * w * 4)
      }
      return { width: w, height: h, data: out }
    }
    function resizeNN(img, scale) {
      if (scale === 1) return img
      const w = img.width * scale
      const h = img.height * scale
      const out = new Uint8Array(w * h * 4)
      for (let y = 0; y < h; y++) {
        const sy = Math.floor(y / scale)
        const srow = sy * img.width * 4
        for (let x = 0; x < w; x++) {
          const s = srow + Math.floor(x / scale) * 4
          const d = (y * w + x) * 4
          out[d] = img.data[s]
          out[d + 1] = img.data[s + 1]
          out[d + 2] = img.data[s + 2]
          out[d + 3] = img.data[s + 3]
        }
      }
      return { width: w, height: h, data: out }
    }
    function putRect(img, box, color, thickness) {
      const [x1, y1, x2, y2] = box
      const t = Math.max(1, thickness | 0)
      for (let i = 0; i < t; i++) {
        const L = x1 + i
        const R = x2 - 1 - i
        const T = y1 + i
        const B = y2 - 1 - i
        if (L > R || T > B) break
        for (let x = L; x <= R; x++) { putPx(img, x, T, color); putPx(img, x, B, color) }
        for (let y = T; y <= B; y++) { putPx(img, L, y, color); putPx(img, R, y, color) }
      }
    }
    function putPx(img, x, y, color) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) return
      const d = (y * img.width + x) * 4
      img.data[d] = color[0]
      img.data[d + 1] = color[1]
      img.data[d + 2] = color[2]
      img.data[d + 3] = 255
    }
    function putPoint(img, x, y, color, size) {
      for (let dy = -size; dy <= size; dy++) {
        for (let dx = -size; dx <= size; dx++) {
          if (dx * dx + dy * dy > size * size) continue
          putPx(img, x + dx, y + dy, color)
        }
      }
    }
    function putLine(img, x0, y0, x1, y1, color, thickness) {
      const t = Math.max(1, Math.floor(thickness / 2))
      const dx = Math.abs(x1 - x0)
      const dy = -Math.abs(y1 - y0)
      const sx = x0 < x1 ? 1 : -1
      const sy = y0 < y1 ? 1 : -1
      let err = dx + dy
      for (;;) {
        for (let ox = -t; ox <= t; ox++) {
          for (let oy = -t; oy <= t; oy++) putPx(img, x0 + ox, y0 + oy, color)
        }
        if (x0 === x1 && y0 === y1) break
        const e2 = 2 * err
        if (e2 >= dy) { err += dy; x0 += sx }
        if (e2 <= dx) { err += dx; y0 += sy }
      }
    }
    const FONT = {
      '0': [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
      '1': [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
      '2': [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
      '3': [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
      '4': [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
      '5': [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
      '6': [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
      '7': [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
      '8': [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
      '9': [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
      'A': [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
      'B': [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
      'C': [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E],
      'D': [0x1C, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1C],
      'E': [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F],
      'F': [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
      'G': [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F],
      'H': [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
      'I': [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E],
      'J': [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C],
      'K': [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
      'L': [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
      'M': [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11],
      'N': [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
      'O': [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
      'P': [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
      'Q': [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D],
      'R': [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
      'S': [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E],
      'T': [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
      'U': [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
      'V': [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
      'W': [0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11],
      'X': [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
      'Y': [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04],
      'Z': [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F],
      '-': [0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00],
      '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x0C],
      '?': [0x0E, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04]
    }
    function textSize(text, scale) {
      let w = 0
      for (const ch of String(text).toUpperCase()) w += 6 * scale
      return { w: w - scale, h: 7 * scale }
    }
    function putText(img, text, x, y, scale, color) {
      let cx = x
      for (const ch of String(text).toUpperCase()) {
        const g = FONT[ch] || FONT['?']
        for (let row = 0; row < 7; row++) {
          const bits = g[row]
          for (let col = 0; col < 5; col++) {
            if (!(bits & (1 << (4 - col)))) continue
            for (let dy = 0; dy < scale; dy++) {
              for (let dx = 0; dx < scale; dx++) putPx(img, cx + col * scale + dx, y + row * scale + dy, color)
            }
          }
        }
        cx += 6 * scale
      }
    }

    /* --------------------------- 颜色 / 分析 --------------------------- */

    const COLOR_NAMES = {
      red: [220, 40, 40],
      green: [40, 180, 80],
      blue: [40, 110, 240],
      yellow: [235, 200, 30],
      orange: [240, 140, 30],
      purple: [150, 60, 220],
      cyan: [40, 200, 220],
      magenta: [230, 60, 180],
      white: [255, 255, 255],
      black: [0, 0, 0],
      gray: [128, 128, 128],
      grey: [128, 128, 128]
    }
    function parseColor(spec) {
      if (typeof spec !== 'string') throw new Error('color must be a string')
      const s = spec.trim().toLowerCase()
      if (COLOR_NAMES[s]) return { mode: 'rgb', rgb: COLOR_NAMES[s] }
      const m = s.match(/^\[?\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\]?$/)
      if (m) return { mode: 'rgb', rgb: [+m[1], +m[2], +m[3]] }
      const r = s.match(/^\[?\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\]?$/)
      if (r) return { mode: 'range', lo: [+r[1], +r[2], +r[3]], hi: [+r[4], +r[5], +r[6]] }
      throw new Error('cannot parse color: ' + spec)
    }
    function findColor(img, spec, region, tolerance, minArea, maxResults) {
      const c = parseColor(spec)
      const box = region && region.length === 4 ? clampBox(region, img.width, img.height) : [0, 0, img.width, img.height]
      const step = 2
      const gw = Math.ceil((box[2] - box[0]) / step)
      const gh = Math.ceil((box[3] - box[1]) / step)
      const mask = new Uint8Array(gw * gh)
      const tol = tolerance === undefined ? 32 : tolerance
      for (let gy = 0; gy < gh; gy++) {
        for (let gx = 0; gx < gw; gx++) {
          const x = box[0] + gx * step
          const y = box[1] + gy * step
          if (x >= img.width || y >= img.height) continue
          const d = (y * img.width + x) * 4
          const rr = img.data[d]
          const gg = img.data[d + 1]
          const bb = img.data[d + 2]
          let hit = false
          if (c.mode === 'rgb') {
            hit = Math.abs(rr - c.rgb[0]) <= tol && Math.abs(gg - c.rgb[1]) <= tol && Math.abs(bb - c.rgb[2]) <= tol
          } else {
            hit = rr >= c.lo[0] && rr <= c.hi[0] && gg >= c.lo[1] && gg <= c.hi[1] && bb >= c.lo[2] && bb <= c.hi[2]
          }
          if (hit) mask[gy * gw + gx] = 1
        }
      }
      const seen = new Uint8Array(gw * gh)
      const comps = []
      const minCells = minArea === undefined ? 4 : Math.max(1, Math.round(minArea / (step * step)))
      for (let start = 0; start < gw * gh; start++) {
        if (!mask[start] || seen[start]) continue
        let minGX = gw
        let maxGX = 0
        let minGY = gh
        let maxGY = 0
        let area = 0
        let sx = 0
        let sy = 0
        const stack = [start]
        seen[start] = 1
        while (stack.length) {
          const p = stack.pop()
          const gx = p % gw
          const gy = (p / gw) | 0
          if (gx < minGX) minGX = gx
          if (gx > maxGX) maxGX = gx
          if (gy < minGY) minGY = gy
          if (gy > maxGY) maxGY = gy
          area++
          sx += gx
          sy += gy
          if (gx + 1 < gw) { const np = p + 1; if (mask[np] && !seen[np]) { seen[np] = 1; stack.push(np) } }
          if (gx - 1 >= 0) { const np = p - 1; if (mask[np] && !seen[np]) { seen[np] = 1; stack.push(np) } }
          if (gy + 1 < gh) { const np = p + gw; if (mask[np] && !seen[np]) { seen[np] = 1; stack.push(np) } }
          if (gy - 1 >= 0) { const np = p - gw; if (mask[np] && !seen[np]) { seen[np] = 1; stack.push(np) } }
        }
        if (area >= minCells) {
          comps.push({
            area: area * step * step,
            box: [box[0] + minGX * step, box[1] + minGY * step, box[0] + (maxGX + 1) * step, box[1] + (maxGY + 1) * step],
            center: [box[0] + Math.round((sx / area + 0.5) * step), box[1] + Math.round((sy / area + 0.5) * step)]
          })
        }
      }
      comps.sort((a, b) => b.area - a.area)
      return maxResults === undefined ? comps : comps.slice(0, maxResults)
    }
    function diffFrames(a, b, region, threshold) {
      if (a.width !== b.width || a.height !== b.height) {
        throw new Error('frames must have identical dimensions for diff; capture both with the same region')
      }
      const box = region && region.length === 4 ? clampBox(region, a.width, a.height) : [0, 0, a.width, a.height]
      const th = threshold === undefined ? 40 : threshold
      let minX = a.width
      let minY = a.height
      let maxX = -1
      let maxY = -1
      let count = 0
      let sampled = 0
      const changed = new Uint8Array(a.width * a.height)
      for (let y = box[1]; y < box[3]; y += 2) {
        for (let x = box[0]; x < box[2]; x += 2) {
          sampled++
          const d = (y * a.width + x) * 4
          const dr = Math.abs(a.data[d] - b.data[d])
          const dg = Math.abs(a.data[d + 1] - b.data[d + 1])
          const db = Math.abs(a.data[d + 2] - b.data[d + 2])
          if (dr + dg + db > th) {
            changed[y * a.width + x] = 1
            count++
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
      }
      return {
        count,
        sampled,
        ratio: sampled === 0 ? 0 : count / sampled,
        bbox: count > 0 ? [minX, minY, maxX + 1, maxY + 1] : null,
        changed
      }
    }

    /* --------------------------- 会话状态机 --------------------------- */

    const state = {
      frames: {},
      order: [],
      current: null,
      grounding: null,
      grids: {},
      seq: 0,
      screenInfo: null
    }
    function newFrame(path, w, h, data, origin, base) {
      const id = 'f' + (++state.seq)
      state.frames[id] = { id, path, width: w, height: h, data, origin: origin || null, base: base || null }
      state.order.push(id)
      while (state.order.length > 8) {
        const refs = new Set()
        for (const fid of Object.keys(state.frames)) {
          const f = state.frames[fid]
          if (f.base) refs.add(f.base.frameId)
        }
        let victim = null
        for (const fid of state.order) {
          if (!refs.has(fid) && fid !== state.current) { victim = fid; break }
        }
        if (victim === null) break
        state.order = state.order.filter((f) => f !== victim)
        delete state.frames[victim]
        if (state.grids[victim]) delete state.grids[victim]
        if (state.grounding && state.grounding.frameId === victim) state.grounding = null
      }
      state.current = id
      return id
    }
    function getFrame(id) {
      const f = id ? state.frames[id] : state.frames[state.current]
      if (!f) throw new Error(id ? ('unknown frame id: ' + id) : 'no current frame; run vision_capture first')
      return f
    }
    function frameToScreen(frameId, px, py) {
      const f = state.frames[frameId]
      if (!f) throw new Error('frame ' + frameId + ' was evicted; re-capture the scene')
      if (f.base) {
        const bx = f.base.box[0] + px / f.base.scale
        const by = f.base.box[1] + py / f.base.scale
        return frameToScreen(f.base.frameId, bx, by)
      }
      if (!f.origin) return null
      return { x: f.origin.sx + px, y: f.origin.sy + py }
    }

    /* ----------------------- fs / subprocess 适配 ----------------------- */

    async function readTextNative(path) {
      const t = await fsSvc.resolve(path)
      return fsSvc.readText(t)
    }
    async function readJsonNative(path) {
      let s = await readTextNative(path)
      if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1)
      return JSON.parse(s)
    }
    async function writeTextNative(path, content) {
      const t = await fsSvc.resolve(path)
      return fsSvc.writeText(t, content)
    }
    async function readBytesNative(path, maxBytes) {
      const t = await fsSvc.resolve(path)
      return fsSvc.readBytes(t, undefined, maxBytes)
    }

    let psExe = null
    let readyPromise = null
    let psSeq = 0
    function psQuoteWin(s) {
      return s.replace(/'/g, "''")
    }
    function ensureReady() {
      if (readyPromise) return readyPromise
      readyPromise = (async () => {
        for (const cand of ['powershell', 'pwsh']) {
          try {
            psExe = await spSvc.resolveExecutable(cand)
            break
          } catch (e) { /* try next */ }
        }
        if (psExe === null) throw new Error('no PowerShell executable found (tried powershell, pwsh)')
        const mkdirCmd = `New-Item -ItemType Directory -Force -Path '${psQuoteWin(storeDir)}' | Out-Null; New-Item -ItemType Directory -Force -Path '${psQuoteWin(framesDir)}' | Out-Null`
        const h1 = spSvc.spawn({
          argv: [psExe, '-NoProfile', '-NonInteractive', '-Command', mkdirCmd],
          cwd: workspaceRoot,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 16384 } },
          graceMs: 20000
        })
        const o1 = await h1.done
        if (o1.exitCode !== 0) {
          let e = ''
          try { e = h1.collected.stderr.readFrom(0).text.trim() } catch (x) { e = '' }
          throw new Error('cannot create vision store dir: ' + e)
        }
        await writeTextNative(helperPath, PS_SCRIPT)
        await writeTextNative(mimoClientPath, MIMO_CLIENT)
        return psExe
      })()
      return readyPromise
    }
    async function psRun(cmd, payload, signal) {
      await ensureReady()
      const tag = 'p' + (++psSeq)
      const argsPath = `${storeDir}/tmp-args-${tag}.json`
      const resPath = `${storeDir}/tmp-res-${tag}.json`
      // PS 5.1 Get-Content 需要 BOM 才能正确识别 UTF-8
      await writeTextNative(argsPath, '\uFEFF' + JSON.stringify(payload))
      const handle = spSvc.spawn({
        argv: [psExe, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath, cmd, argsPath, resPath],
        cwd: workspaceRoot,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 262144 }, stderr: { maxBytes: 262144 } },
        graceMs: 30000,
        signal
      })
      const outcome = await handle.done
      let result = null
      try { result = await readJsonNative(resPath) } catch (e) { result = null }
      if (outcome.exitCode !== 0 || !result || result.ok === false) {
        let err = (result && result.error) || ''
        if (!err) {
          try { err = handle.collected.stderr.readFrom(0).text.trim() } catch (e) { err = '' }
        }
        throw new Error('vision-helper(' + cmd + ') failed: ' + (err || ('exit ' + outcome.exitCode)))
      }
      return result
    }
    async function savePngNative(path, img) {
      const bytes = encodePng(img.width, img.height, img.data)
      await psRun('write', { path, data: b64encode(bytes) })
      return path
    }
    async function loadPngNative(path) {
      const bytes = await readBytesNative(path, 96 * 1024 * 1024)
      return decodePng(bytes)
    }
    async function ensureScreenInfo(signal) {
      if (!state.screenInfo) state.screenInfo = await psRun('screeninfo', {}, signal)
      return state.screenInfo
    }

    /* --------------------- PowerShell 系统边界脚本 --------------------- */
    /* 仅承担 3 类必须离开 Node 运行时的工作: 截屏 / OCR / 二进制落盘 */

    const PS_SCRIPT = `
param([string]$Cmd, [string]$ArgsFile, [string]$ResultFile)
$ErrorActionPreference = 'Stop'
function Fail([string]$msg) {
  try { $o = @{ ok = $false; error = $msg } | ConvertTo-Json -Depth 6; Set-Content -Path $ResultFile -Value $o -Encoding UTF8 } catch {}
  exit 1
}
try {
  Add-Type -AssemblyName System.Drawing | Out-Null
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class Nat{ [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }' -ErrorAction SilentlyContinue | Out-Null
  [void][Nat]::SetProcessDPIAware()
  $a = Get-Content -Path $ArgsFile -Raw | ConvertFrom-Json
  $res = @{ ok = $true }
  function Get-VirtualBounds {
    $ss = [System.Windows.Forms.Screen]::AllScreens
    $minX = ($ss | ForEach-Object { $_.Bounds.Left } | Measure-Object -Minimum).Minimum
    $minY = ($ss | ForEach-Object { $_.Bounds.Top } | Measure-Object -Minimum).Minimum
    $maxX = ($ss | ForEach-Object { $_.Bounds.Right } | Measure-Object -Maximum).Maximum
    $maxY = ($ss | ForEach-Object { $_.Bounds.Bottom } | Measure-Object -Maximum).Maximum
    return @($minX, $minY, $maxX, $maxY)
  }
  switch ($Cmd) {
    'screeninfo' {
      $ss = [System.Windows.Forms.Screen]::AllScreens
      $vb = Get-VirtualBounds
      $res.bounds = $vb
      $res.monitors = @($ss | ForEach-Object { @{ device = $_.DeviceName; primary = $_.Primary; bounds = @($_.Bounds.Left, $_.Bounds.Top, $_.Bounds.Right, $_.Bounds.Bottom) } })
    }
    'capture' {
      $vb = Get-VirtualBounds
      $vw = [int]($vb[2] - $vb[0]); $vh = [int]($vb[3] - $vb[1])
      $bmp = New-Object System.Drawing.Bitmap($vw, $vh)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
        $g.CopyFromScreen($s.Bounds.Location, [System.Drawing.Point]::new([int]($s.Bounds.Left - $vb[0]), [int]($s.Bounds.Top - $vb[1])), $s.Bounds.Size)
      }
      $g.Dispose()
      $save = $bmp
      $ox = [int]$vb[0]; $oy = [int]$vb[1]
      if ($null -ne $a.region -and $a.region.Count -eq 4) {
        $rx = [int]$a.region[0] - $ox; $ry = [int]$a.region[1] - $oy
        $rw = [int]($a.region[2] - $a.region[0]); $rh = [int]($a.region[3] - $a.region[1])
        $rect = New-Object System.Drawing.Rectangle($rx, $ry, $rw, $rh)
        $save = $bmp.Clone($rect, $bmp.PixelFormat)
        $bmp.Dispose()
        $ox = [int]$a.region[0]; $oy = [int]$a.region[1]
      }
      $outPath = [System.IO.Path]::GetFullPath([string]$a.path)
      $dir = [System.IO.Path]::GetDirectoryName($outPath)
      if (!(Test-Path $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
      $save.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $res.path = $outPath; $res.width = $save.Width; $res.height = $save.Height
      $res.origin = @($ox, $oy)
      $save.Dispose()
    }
    'write' {
      $outPath = [System.IO.Path]::GetFullPath([string]$a.path)
      $dir = [System.IO.Path]::GetDirectoryName($outPath)
      if (!(Test-Path $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
      $bytes = [System.Convert]::FromBase64String($(([string]$a.data) -replace '\\s',''))
      [System.IO.File]::WriteAllBytes($outPath, $bytes)
      $res.path = $outPath; $res.bytes = $bytes.Length
    }
    'ocr' {
      try {
        Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
        $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
        $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
        $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
        $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' })[0]
        function Await($op, $type) {
          $m = $asTaskGeneric.MakeGenericMethod($type)
          $t = $m.Invoke($null, @($op))
          $t.Wait(-1) | Out-Null
          return $t.Result
        }
        $p = [System.IO.Path]::GetFullPath([string]$a.path)
        $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p)) ([Windows.Storage.StorageFile])
        $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        if ($null -eq $engine) { Fail 'no OCR language pack available for the current user profile' }
        $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        $words = @()
        foreach ($line in $result.Lines) {
          foreach ($word in $line.Words) {
            $r = $word.BoundingRect
            $words += @{ text = $word.Text; box = @([int]$r.X, [int]$r.Y, [int]($r.X + $r.Width), [int]($r.Y + $r.Height)) }
          }
        }
        $res.words = @($words)
        $res.count = $words.Count
      } catch {
        Fail ('ocr inner: ' + $_.Exception.ToString())
      }
    }
    default { Fail "unknown helper command: $Cmd" }
  }
  $json = $res | ConvertTo-Json -Depth 8 -Compress
  Set-Content -Path $ResultFile -Value $json -Encoding UTF8
} catch {
  Fail ($_.Exception.Message)
}
`

    /* ------------------- MiMo v2.5 多模态模型后端 ------------------- */
    /* 传输: 经 Host 原生 subprocess 服务派生 node 子进程, 直连 Xiaomi MiMo OpenAI 兼容 API */

    /* 运行时配置, 优先级: settings 用户设置 > 插件行 config(base) > 内置默认值。
       bundle 版由 index.js 注入 harness.vprSettings (schemastery schema +
       installSettingsSection), 在 WebUI 设置 → 插件配置 中可编辑;
       动态插件沙箱无该注入时, 仅使用 config/默认值与 credentials。 */
    const MIMO_BASE_DEFAULT = 'https://api.xiaomimimo.com/v1'
    const MIMO_MODEL_DEFAULT = 'mimo-v2.5'
    let liveConfig = Object.assign({ baseUrl: MIMO_BASE_DEFAULT, model: MIMO_MODEL_DEFAULT, timeoutMs: 300000 }, config || {})
    const cfgBaseUrl = () => (liveConfig && typeof liveConfig.baseUrl === 'string' && liveConfig.baseUrl.length > 0 ? liveConfig.baseUrl : MIMO_BASE_DEFAULT)
    const cfgModel = () => (liveConfig && typeof liveConfig.model === 'string' && liveConfig.model.length > 0 ? liveConfig.model : MIMO_MODEL_DEFAULT)
    const cfgTimeout = () => (liveConfig && Number.isFinite(liveConfig.timeoutMs) && liveConfig.timeoutMs > 0 ? liveConfig.timeoutMs : 300000)
    const settingsSvc = ctx.get('settings')
    if (settingsSvc !== undefined && harness.vprSettings !== undefined) {
      try {
        harness.vprSettings.install(ctx, (thunk) => {
          try {
            const resolved = typeof thunk === 'function' ? thunk() : thunk
            if (resolved && typeof resolved === 'object') liveConfig = Object.assign({}, resolved)
          } catch (e) { console.error('mimo: settings resolve failed: ' + (e && e.message)) }
        })
      } catch (e) { console.error('mimo: settings namespace install failed: ' + (e && e.message)) }
    }
    // API key 不硬编码: 优先级 = settings.apiKey (WebUI 卡片) > credentials MIMO_API_KEY。
    // CLI 配置: dsh credentials set MIMO_API_KEY <key>
    let mimoKeyCache = ''
    async function getMimoKey() {
      if (mimoKeyCache) return mimoKeyCache
      if (liveConfig && typeof liveConfig.apiKey === 'string' && liveConfig.apiKey.length > 0) {
        mimoKeyCache = liveConfig.apiKey
        return mimoKeyCache
      }
      const cred = ctx.get('credentials')
      if (cred !== undefined) {
        try {
          const v = await Promise.resolve(cred.get('MIMO_API_KEY'))
          if (v) { mimoKeyCache = String(v); return mimoKeyCache }
        } catch (e) { console.error('mimo: credentials.get failed: ' + (e && e.message)) }
      }
      throw new Error('mimo: MiMo API key 未配置。请在 WebUI 设置 → 插件配置 填写, 或运行: dsh credentials set MIMO_API_KEY <key>')
    }
    const mimoClientPath = `${storeDir}/mimo-client.cjs`

    const MIMO_CLIENT = `
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
`

    let nodeExe = null
    async function ensureNode() {
      if (nodeExe) return nodeExe
      nodeExe = await spSvc.resolveExecutable('node')
      return nodeExe
    }
    async function mimoCall(body, opts) {
      await ensureReady()
      await ensureNode()
      const tag = 'm' + (++psSeq)
      const reqPath = `${storeDir}/mimo-req-${tag}.json`
      await writeTextNative(reqPath, '\uFEFF' + JSON.stringify({ url: `${cfgBaseUrl()}/chat/completions`, apiKey: await getMimoKey(), body, timeoutMs: (opts && opts.timeoutMs) || cfgTimeout() }))
      return spSvc.spawn({
        argv: [nodeExe, mimoClientPath, opts && opts.stream ? 'stream' : 'json', reqPath],
        cwd: workspaceRoot,
        stdio: { stdin: 'ignore', stdout: opts && opts.stream ? 'pipe' : { maxBytes: 32 * 1024 * 1024 }, stderr: { maxBytes: 65536 } },
        graceMs: 60000,
        signal: opts && opts.signal
      })
    }
    async function mimoChat(messages, signal) {
      const handle = await mimoCall({ model: cfgModel(), messages, stream: false, max_tokens: 4096 }, { stream: false, signal })
      const outcome = await handle.done
      let text = ''
      try { text = handle.collected.stdout.readFrom(0).text.trim() } catch (e) { text = '' }
      if (outcome.exitCode !== 0 || !text) {
        let err = ''
        try { err = handle.collected.stderr.readFrom(0).text.trim() } catch (e) { err = '' }
        throw new Error('mimo transport failed: ' + (text || err || ('exit ' + outcome.exitCode)))
      }
      let ev = null
      try { ev = JSON.parse(text) } catch (e) { throw new Error('mimo bad output: ' + text.slice(0, 300)) }
      if (ev.type === 'error') throw new Error('MiMo API ' + (ev.status ? '(HTTP ' + ev.status + ') ' : '') + ev.message)
      const msg = ev.data && ev.data.choices && ev.data.choices[0] && ev.data.choices[0].message
      if (!msg) throw new Error('MiMo API returned no message')
      return msg
    }
    function downscale(img, maxEdge) {
      const s = Math.max(1, Math.ceil(Math.max(img.width, img.height) / maxEdge))
      if (s === 1) return img
      const w = Math.floor(img.width / s)
      const h = Math.floor(img.height / s)
      const out = new Uint8Array(w * h * 4)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const d = (y * w + x) * 4
          const src = ((y * s) * img.width + (x * s)) * 4
          out[d] = img.data[src]
          out[d + 1] = img.data[src + 1]
          out[d + 2] = img.data[src + 2]
          out[d + 3] = 255
        }
      }
      return { width: w, height: h, data: out }
    }
    function frameDataUrl(img) {
      return 'data:image/png;base64,' + b64encode(encodePng(img.width, img.height, img.data))
    }
    function textOfBlocks(blocks) {
      let t = ''
      for (const b of blocks) if (b.type === 'text') t += b.text
      return t
    }
    async function serializeMimoRequest(o) {
      const messages = []
      if (o.system) messages.push({ role: 'system', content: o.system })
      for (const msg of o.messages) {
        if (msg.role === 'system') {
          messages.push({ role: 'system', content: textOfBlocks(msg.content) })
        } else if (msg.role === 'user') {
          const trs = msg.content.filter((b) => b.type === 'tool-result')
          if (trs.length === 1 && msg.content.length === 1) {
            messages.push({ role: 'tool', tool_call_id: trs[0].toolCallId, content: textOfBlocks(trs[0].content) })
            continue
          }
          const parts = []
          let text = ''
          for (const b of msg.content) {
            if (b.type === 'text') text += b.text
            else if (b.type === 'image') {
              const att = ctx.get('attachments')
              if (!att) throw new Error('mimo: image content needs the attachments service')
              const stored = await att.readImage(b.attachment, o.signal)
              parts.push({ type: 'image_url', image_url: { url: `data:${stored.ref.mediaType};base64,${b64encode(stored.data)}` } })
            }
          }
          if (text && parts.length) messages.push({ role: 'user', content: [{ type: 'text', text }, ...parts] })
          else if (text) messages.push({ role: 'user', content: text })
          else if (parts.length) messages.push({ role: 'user', content: parts })
          else messages.push({ role: 'user', content: '' })
        } else if (msg.role === 'assistant') {
          const toolCalls = []
          let text = ''
          for (const b of msg.content) {
            if (b.type === 'text') text += b.text
            else if (b.type === 'tool-call') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } })
          }
          messages.push(toolCalls.length
            ? { role: 'assistant', content: text || null, tool_calls: toolCalls }
            : { role: 'assistant', content: text })
        }
      }
      const body = { model: o.model, messages, stream: true }
      if (o.tools && o.tools.length) body.tools = o.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
      if (o.maxTokens) body.max_tokens = o.maxTokens
      if (typeof o.temperature === 'number') body.temperature = o.temperature
      if (o.stop && o.stop.length) body.stop = o.stop
      return body
    }
    const MIMO_ADAPTER = {
      providerInfo(provider) {
        return { id: provider, name: 'Xiaomi MiMo' }
      },
      providerRetryPolicy() {
        return undefined
      },
      listModels(provider) {
        return Promise.resolve([
          { provider, id: 'mimo-v2.5', name: 'MiMo V2.5', description: '全模态理解(图像/音频/视频), 1M 上下文', inputModalities: ['text', 'image'] },
          { provider, id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', description: '文本/深度思考, 1M 上下文', inputModalities: ['text'] }
        ])
      },
      resolveModel(provider, model) {
        const mm = model === 'mimo-v2.5'
        return Promise.resolve({
          provider,
          id: model,
          name: mm ? 'MiMo V2.5' : 'MiMo V2.5 Pro',
          inputModalities: mm ? ['text', 'image'] : ['text'],
          context: { contextWindow: 1000000 },
          defaultMaxTokens: 16384
        })
      },
      async *stream(options) {
        const body = await serializeMimoRequest(options)
        const handle = await mimoCall(body, { stream: true, signal: options.signal })
        const st = { startedText: false, textFull: '', tools: new Map(), toolOrder: [], finishReason: 'stop', usage: null }
        let buf = ''
        for await (const chunk of handle.stdout) {
          buf += chunk.toString('utf8')
          let nl
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl)
            buf = buf.slice(nl + 1)
            if (!line) continue
            let ev
            try { ev = JSON.parse(line) } catch (e) { continue }
            if (ev.type === 'error') throw new Error('MiMo API ' + (ev.status ? '(HTTP ' + ev.status + ') ' : '') + ev.message)
            if (ev.type === 'done') continue
            if (ev.type !== 'data') continue
            let payload
            try { payload = JSON.parse(ev.json) } catch (e) { continue }
            if (payload.usage) {
              const u = payload.usage
              const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0
              st.usage = {
                inputTokens: Math.max(0, (u.prompt_tokens || 0) - cached),
                outputTokens: u.completion_tokens || 0,
                ...(cached > 0 ? { cacheReadTokens: cached } : {}),
                ...(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens ? { reasoningTokens: u.completion_tokens_details.reasoning_tokens } : {})
              }
            }
            const choice = payload.choices && payload.choices[0]
            if (!choice) continue
            const d = choice.delta || {}
            if (typeof d.content === 'string' && d.content.length) {
              if (!st.startedText) { yield { type: 'block-start', index: 0, blockType: 'text' }; st.startedText = true }
              st.textFull += d.content
              yield { type: 'text-delta', index: 0, text: d.content }
            }
            if (Array.isArray(d.tool_calls)) {
              for (const tc of d.tool_calls) {
                const idx = tc.index === undefined ? 0 : tc.index
                const bi = st.startedText ? idx + 1 : idx
                const isNew = !st.tools.has(idx)
                if (isNew) { st.tools.set(idx, { id: '', name: '', args: '' }); st.toolOrder.push(idx); yield { type: 'block-start', index: bi, blockType: 'tool-call' } }
                const t = st.tools.get(idx)
                if (tc.id) t.id = tc.id
                const fn = tc.function || {}
                if (fn.name) t.name = fn.name
                const argDelta = fn.arguments || ''
                t.args += argDelta
                yield { type: 'tool-call-delta', index: bi, id: t.id, ...(isNew && t.name ? { name: t.name } : {}), argumentsDelta: argDelta }
              }
            }
            if (choice.finish_reason) st.finishReason = choice.finish_reason
          }
        }
        const outcome = await handle.done
        if (outcome.exitCode !== 0) {
          let err = ''
          try { err = handle.collected.stderr.readFrom(0).text.trim() } catch (e) { err = '' }
          throw new Error('mimo transport failed (exit ' + outcome.exitCode + '): ' + err)
        }
        if (st.startedText) yield { type: 'block-end', index: 0, block: { type: 'text', text: st.textFull } }
        for (const idx of st.toolOrder) {
          const t = st.tools.get(idx)
          const bi = st.startedText ? idx + 1 : idx
          yield { type: 'block-end', index: bi, block: { type: 'tool-call', id: t.id, name: t.name, arguments: t.args } }
        }
        if (st.usage) yield { type: 'usage', usage: st.usage }
        yield { type: 'finish', reason: { kind: st.finishReason === 'tool_calls' ? 'tool-calls' : st.finishReason === 'length' ? 'max-tokens' : 'stop' } }
      }
    }

    /* ------------------------------ 工具注册 ------------------------------ */

    const renderJson = (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    const JSON_OUT = { schema: { type: 'json' }, render: renderJson }

    /* ---------- Visual Evidence Protocol (视觉证据协议) ----------
     * 把图片文本化为"模型间可视化交流语言":
     *   VLM 先思考(reasoning 草稿, 默认丢弃) → 结构化输出
     *   { caption(自然语言语义), layout(布局概述), elements[{label, box_norm,
     *     text, confidence}] } → 确定性后处理把 box_norm(0-1000) 映射为
     *   像素 box/中心点/所属 SOM 格子编号(4x4, 存入 state.grids 可直接
     *   vision_resolve) —— 将 VLM 的模糊感知桥接到确定性像素数学。
     * 用户贴图(paste-to-path quick 模式)与模型主动调用(vision_analyze
     * full 模式)共用同一协议。 */
    function gridCellsOf(w, h, rows, cols) {
      const cells = []
      const cw = w / cols
      const ch = h / rows
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const n = r * cols + c + 1
          const box = [Math.round(c * cw), Math.round(r * ch), Math.round((c + 1) * cw), Math.round((r + 1) * ch)]
          cells.push({ n, box, center: [Math.round((box[0] + box[2]) / 2), Math.round((box[1] + box[3]) / 2)] })
        }
      }
      return cells
    }
    function attachGeometry(el, img, frameId, cells) {
      const w = img.width
      const h = img.height
      const boxNorm = Array.isArray(el.box) && el.box.length === 4 ? el.box.map((v) => clampInt(v, 0, 1000, 0)) : [0, 0, 1000, 1000]
      const box = [Math.round(boxNorm[0] * w / 1000), Math.round(boxNorm[1] * h / 1000), Math.round(boxNorm[2] * w / 1000), Math.round(boxNorm[3] * h / 1000)]
      const center = [Math.round((box[0] + box[2]) / 2), Math.round((box[1] + box[3]) / 2)]
      let cell = null
      if (cells) {
        for (const c of cells) {
          if (center[0] >= c.box[0] && center[0] < c.box[2] && center[1] >= c.box[1] && center[1] < c.box[3]) { cell = c; break }
        }
      }
      const out = {
        label: typeof el.label === 'string' ? el.label : 'element',
        text: typeof el.text === 'string' ? el.text : '',
        confidence: Number.isFinite(el.confidence) ? Math.max(0, Math.min(1, el.confidence)) : 0,
        box,
        box_norm: boxNorm,
        center,
        grid_cell: cell ? cell.n : null,
        grid_box: cell ? cell.box : null
      }
      if (frameId && state.frames[frameId]) {
        const sc = frameToScreen(frameId, center[0], center[1])
        if (sc) out.screen_center = [Math.round(sc.x), Math.round(sc.y)]
      }
      return out
    }
    const ANALYZE_PROMPT = (img, maxElements) => `你是精确的视觉理解与定位助手。分析这张图片,只输出一个纯 JSON 对象(不要 markdown 代码块, 不要任何其它文字):
{"caption":"2-4 句自然语言语义描述: 图片整体内容/场景/界面用途","layout":"1-2 句整体布局概述(分区与主次关系)","elements":[{"label":"元素简短名称","box":[x1,y1,x2,y2],"text":"元素上的文字(没有则空串)","confidence":0到1}]}
坐标规则: box 使用归一化坐标, 每个值都是 0-1000 的整数(0=左/上边缘, 1000=右/下边缘), 紧致包围目标。elements 只列最重要的至多 ${maxElements} 个元素(按钮/输入框/标题/图标/图片/文本块等), 按重要性降序; 没有重要元素时用空数组。`
    async function analyzeImageCore(img, maxElements, signal, dataUrlOverride) {
      const messages = [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrlOverride || frameDataUrl(img) } },
          { type: 'text', text: ANALYZE_PROMPT(img, maxElements) }
        ]
      }]
      let msg = null
      let raw = ''
      try {
        msg = await mimoChat(messages, signal)
        raw = (msg && msg.content) || ''
      } catch (e) {
        raw = ''
      }
      let parsed = null
      const m = raw.match(/\{[\s\S]*\}/)
      if (m) { try { parsed = JSON.parse(m[0]) } catch (e) { parsed = null } }
      if (!parsed || typeof parsed.caption !== 'string' || !Array.isArray(parsed.elements)) {
        // 一次宽松重试: 强调纯 JSON
        messages[0].content[1].text = ANALYZE_PROMPT(img, maxElements) + '\n注意: 直接输出 JSON 对象本身, 不要用 ``` 包裹, 不要解释。'
        msg = await mimoChat(messages, signal)
        raw = (msg && msg.content) || ''
        parsed = null
        const m2 = raw.match(/\{[\s\S]*\}/)
        if (m2) { try { parsed = JSON.parse(m2[0]) } catch (e) { parsed = null } }
        if (!parsed || typeof parsed.caption !== 'string' || !Array.isArray(parsed.elements)) {
          return { ok: false, raw: raw.slice(0, 1200), note: 'MiMo 结构化输出解析失败; 可重试或改用 vision_describe' }
        }
      }
      const reasoning = typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0 ? msg.reasoning_content : null
      const elements = parsed.elements.slice(0, Math.max(1, Math.min(24, maxElements || 8)))
      return {
        ok: true,
        caption: String(parsed.caption),
        layout: typeof parsed.layout === 'string' ? parsed.layout : '',
        elements,
        ...(reasoning ? { reasoning } : {})
      }
    }

    function resolveSync(args) {
      const f = getFrame(args.frame_id)
      const given = (args.cell !== undefined ? 1 : 0) + (args.box !== undefined ? 1 : 0) + (args.point !== undefined ? 1 : 0)
      if (given !== 1) throw new Error('provide exactly one of cell / box / point')
      let box
      let point
      if (args.cell !== undefined) {
        const g = state.grids[f.id]
        if (!g) throw new Error('no grid on frame ' + f.id + '; run vision_grid first')
        const cell = g.cells.find((c) => c.n === args.cell)
        if (!cell) throw new Error('cell ' + args.cell + ' not found; valid range 1..' + (g.rows * g.cols))
        box = cell.box
        point = cell.center
      } else if (args.box !== undefined) {
        box = clampBox(args.box, f.width, f.height)
        point = [Math.round((box[0] + box[2]) / 2), Math.round((box[1] + box[3]) / 2)]
      } else {
        point = [Math.min(f.width - 1, Math.max(0, Math.round(args.point[0]))), Math.min(f.height - 1, Math.max(0, Math.round(args.point[1])))]
        box = [point[0], point[1], point[0] + 1, point[1] + 1]
      }
      const sc = frameToScreen(f.id, point[0], point[1])
      state.grounding = { frameId: f.id, point, box }
      return { frame_id: f.id, box, center: point, screen_point: sc ? [Math.round(sc.x), Math.round(sc.y)] : null, size: [box[2] - box[0], box[3] - box[1]] }
    }

    function posOf(f, spec) {
      if (!spec || typeof spec !== 'object') throw new Error('position must be {box?|point?|cell?}')
      if (spec.cell !== undefined) {
        const r = resolveSync({ frame_id: f.id, cell: spec.cell })
        return { point: r.center, box: r.box }
      }
      if (Array.isArray(spec.box)) {
        const box = clampBox(spec.box, f.width, f.height)
        return { point: [Math.round((box[0] + box[2]) / 2), Math.round((box[1] + box[3]) / 2)], box }
      }
      if (Array.isArray(spec.point)) {
        const p = [clampInt(spec.point[0], 0, f.width - 1, 0), clampInt(spec.point[1], 0, f.height - 1, 0)]
        return { point: p, box: [p[0], p[1], p[0] + 1, p[1] + 1] }
      }
      throw new Error('position missing box/point/cell')
    }

    const TOOLS = [
      harness.defineTool({
        name: 'vision_capture',
        description: '捕获视觉帧:截取屏幕(全屏或指定区域,Windows 原生 Graphics.CopyFromScreen)或读取工作区 PNG 图片。帧解码后驻留插件原生运行时内存,成为后续 vision_grid/vision_resolve/vision_zoom/vision_annotate 的当前帧。屏幕帧记录屏幕坐标系原点,解析出的像素坐标可自动换算为绝对屏幕坐标,便于与其它截图/工具对照。',
        parameters: {
          source: { type: 'string', required: true, enum: ['screen', 'file'], description: "帧来源:'screen' 截取屏幕;'file' 读取工作区图片(需同时给 path)" },
          region: { type: 'array', items: { type: 'number' }, description: '仅 source=screen:截取区域 [x1,y1,x2,y2] 绝对屏幕像素坐标,省略则截取整个虚拟桌面(多显示器合并)' },
          path: { type: 'string', description: '仅 source=file:工作区 PNG 图片的绝对路径' }
        },
        output: JSON_OUT,
        timeoutMs: 30000,
        async execute(args, exec) {
          if (args.source === 'screen') {
            const info = await ensureScreenInfo(exec.signal)
            const b = info.bounds
            let region = null
            if (Array.isArray(args.region) && args.region.length === 4) {
              region = args.region.map((v) => Math.round(v))
              region[0] = Math.max(b[0], Math.min(b[2], region[0]))
              region[1] = Math.max(b[1], Math.min(b[3], region[1]))
              region[2] = Math.max(b[0], Math.min(b[2], region[2]))
              region[3] = Math.max(b[1], Math.min(b[3], region[3]))
              if (region[2] <= region[0] || region[3] <= region[1]) throw new Error('invalid capture region')
            }
            const path = `${framesDir}/cap-${state.seq + 1}.png`
            const res = await psRun('capture', { path, region }, exec.signal)
            const img = decodePng(await readBytesNative(res.path, 96 * 1024 * 1024))
            const id = newFrame(res.path, img.width, img.height, img.data, { sx: res.origin[0], sy: res.origin[1] }, null)
            return { frame_id: id, width: img.width, height: img.height, path: res.path, origin: res.origin }
          }
          if (typeof args.path !== 'string' || args.path.length === 0) throw new Error('source=file requires path')
          const img = await loadPngNative(args.path)
          const id = newFrame(args.path, img.width, img.height, img.data, null, null)
          return { frame_id: id, width: img.width, height: img.height, path: args.path, origin: null }
        }
      }),
      harness.defineTool({
        name: 'vision_grid',
        description: 'Set-of-Mark 编号网格定位:在当前帧上叠加 rows×cols 编号网格并保存带编号图片(返回 path)。用 read_image 查看该图,选出包含目标的格子编号,再用 vision_resolve(cell=编号) 把"模糊视觉感知"换算成该格子中心的精确像素坐标与屏幕坐标。这是消除视觉模型坐标误差的核心原语。',
        parameters: {
          frame_id: { type: 'string', description: '帧 ID,省略为当前帧' },
          rows: { type: 'integer', description: '网格行数,默认 4,范围 1-12' },
          cols: { type: 'integer', description: '网格列数,默认 4,范围 1-12' },
          color: { type: 'string', description: '网格颜色名称或 [r,g,b],默认 red' }
        },
        output: JSON_OUT,
        timeoutMs: 30000,
        async execute(args) {
          const f = getFrame(args.frame_id)
          const rows = clampInt(args.rows, 1, 12, 4)
          const cols = clampInt(args.cols, 1, 12, 4)
          let color = [220, 40, 40]
          if (args.color) color = parseColor(args.color).rgb || color
          const img = { width: f.width, height: f.height, data: f.data.slice() }
          const cw = f.width / cols
          const ch = f.height / rows
          const cells = []
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const n = r * cols + c + 1
              const box = [Math.round(c * cw), Math.round(r * ch), Math.round((c + 1) * cw), Math.round((r + 1) * ch)]
              cells.push({ n, box, center: [Math.round((box[0] + box[2]) / 2), Math.round((box[1] + box[3]) / 2)] })
              const t = Math.max(2, Math.round(Math.min(cw, ch) / 60))
              putRect(img, box, color, t)
              const scale = Math.max(1, Math.min(6, Math.round(Math.min(cw, ch) / 14)))
              const ts = textSize(String(n), scale)
              putText(img, String(n), box[0] + Math.round((box[2] - box[0] - ts.w) / 2), box[1] + Math.round((box[3] - box[1] - ts.h) / 2), scale, color)
            }
          }
          const path = `${framesDir}/grid-${f.id}-${rows}x${cols}.png`
          await savePngNative(path, img)
          state.grids[f.id] = { rows, cols, cells, path }
          for (const c of cells) {
            const sc = frameToScreen(f.id, c.center[0], c.center[1])
            if (sc) c.screen_center = [Math.round(sc.x), Math.round(sc.y)]
          }
          return { path, frame_id: f.id, rows, cols, cells }
        }
      }),
      harness.defineTool({
        name: 'vision_resolve',
        description: '把视觉选择换算成精确坐标:输入格子编号(cell,来自 vision_grid)、包围盒(box)或点(point),输出该帧内精确像素坐标与绝对屏幕坐标(屏幕帧),并记为当前定位锚点(grounding),供 vision_zoom 直接使用。box/point 单位为帧像素。',
        parameters: {
          frame_id: { type: 'string', description: '帧 ID,省略为当前帧' },
          cell: { type: 'integer', description: 'vision_grid 输出的格子编号' },
          box: { type: 'array', items: { type: 'number' }, description: '[x1,y1,x2,y2] 帧像素坐标' },
          point: { type: 'array', items: { type: 'number' }, description: '[x,y] 帧像素坐标' }
        },
        output: JSON_OUT,
        execute(args) {
          return resolveSync(args)
        }
      }),
      harness.defineTool({
        name: 'vision_zoom',
        description: '局部无损放大(最近邻插值,像素级保真):裁切当前帧的某个区域(box/cell/当前定位锚点)并按 scale 放大,保存图片并设为当前帧,供 read_image 细看与进一步 resolve 精修。放大帧保留到原帧的坐标映射链,后续 resolve 仍自动换算为绝对屏幕坐标。',
        parameters: {
          frame_id: { type: 'string', description: '帧 ID,省略为当前帧' },
          box: { type: 'array', items: { type: 'number' }, description: '裁切区域 [x1,y1,x2,y2](帧像素)' },
          cell: { type: 'integer', description: '用 vision_grid 的格子作为裁切区' },
          expand: { type: 'integer', description: '四边外扩像素,默认 0' },
          scale: { type: 'integer', description: '放大倍数 1-8,默认 3' }
        },
        output: JSON_OUT,
        timeoutMs: 30000,
        async execute(args) {
          const f = getFrame(args.frame_id)
          let box
          if (args.cell !== undefined) {
            box = resolveSync({ frame_id: f.id, cell: args.cell }).box
          } else if (Array.isArray(args.box)) {
            box = clampBox(args.box, f.width, f.height)
          } else if (state.grounding && state.grounding.frameId === f.id) {
            box = state.grounding.box
          } else {
            throw new Error('provide box / cell / grounding (run vision_resolve first)')
          }
          const ex = clampInt(args.expand, 0, 500, 0)
          box = clampBox([box[0] - ex, box[1] - ex, box[2] + ex, box[3] + ex], f.width, f.height)
          const scale = clampInt(args.scale, 1, 8, 3)
          const img = resizeNN(crop(f, box), scale)
          const path = `${framesDir}/zoom-${f.id}-${state.seq + 1}.png`
          await savePngNative(path, img)
          const id = newFrame(path, img.width, img.height, img.data, null, { frameId: f.id, box, scale })
          return { path, frame_id: id, width: img.width, height: img.height, src_box: box, scale, note: '用该 frame_id 继续 resolve 时坐标自动映射回屏幕' }
        }
      }),
      harness.defineTool({
        name: 'vision_annotate',
        description: '在帧上绘制标注并保存图片(视觉验证用):box 矩形、point 圆点、cross 十字线、line 线段、text 文字标签。返回标注图路径,用 read_image 核对定位结果。',
        parameters: {
          frame_id: { type: 'string', description: '帧 ID,省略为当前帧' },
          marks: { type: 'json', required: true, description: "标注数组:[{type:'box'|'point'|'cross'|'line'|'text', box?, point?, a?, b?, text?, color?, size?, scale?, thickness?}]" },
          color: { type: 'string', description: '默认标注颜色,默认 red' }
        },
        output: JSON_OUT,
        timeoutMs: 30000,
        async execute(args) {
          const f = getFrame(args.frame_id)
          const img = { width: f.width, height: f.height, data: f.data.slice() }
          const defColor = args.color ? (parseColor(args.color).rgb || [220, 40, 40]) : [220, 40, 40]
          if (!Array.isArray(args.marks)) throw new Error('marks must be an array')
          const drawn = []
          args.marks.forEach((m, i) => {
            if (!m || typeof m !== 'object') throw new Error('mark ' + i + ' must be an object')
            const col = m.color ? (parseColor(m.color).rgb || defColor) : defColor
            const t = clampInt(m.thickness, 1, 12, 3)
            if (m.type === 'box' && Array.isArray(m.box)) {
              const box = clampBox(m.box, f.width, f.height)
              putRect(img, box, col, t)
              drawn.push({ i, type: 'box', box })
            } else if (m.type === 'point' && Array.isArray(m.point)) {
              const p = [clampInt(m.point[0], 0, f.width - 1, 0), clampInt(m.point[1], 0, f.height - 1, 0)]
              putPoint(img, p[0], p[1], col, clampInt(m.size, 2, 40, 6))
              drawn.push({ i, type: 'point', point: p })
            } else if (m.type === 'cross' && Array.isArray(m.point)) {
              const p = [clampInt(m.point[0], 0, f.width - 1, 0), clampInt(m.point[1], 0, f.height - 1, 0)]
              const s = clampInt(m.size, 4, 200, 12)
              putLine(img, p[0] - s, p[1], p[0] + s, p[1], col, t)
              putLine(img, p[0], p[1] - s, p[0], p[1] + s, col, t)
              drawn.push({ i, type: 'cross', point: p })
            } else if (m.type === 'line' && Array.isArray(m.a) && Array.isArray(m.b)) {
              putLine(img, clampInt(m.a[0], 0, f.width - 1, 0), clampInt(m.a[1], 0, f.height - 1, 0), clampInt(m.b[0], 0, f.width - 1, 0), clampInt(m.b[1], 0, f.height - 1, 0), col, t)
              drawn.push({ i, type: 'line' })
            } else if (m.type === 'text' && typeof m.text === 'string' && Array.isArray(m.point)) {
              putText(img, m.text, clampInt(m.point[0], 0, f.width - 1, 0), clampInt(m.point[1], 0, f.height - 1, 0), clampInt(m.scale, 1, 12, 3), col)
              drawn.push({ i, type: 'text' })
            } else {
              throw new Error('mark ' + i + ' has invalid type/fields')
            }
          })
          const path = `${framesDir}/annot-${f.id}-${state.seq + 1}.png`
          await savePngNative(path, img)
          return { path, frame_id: f.id, drawn }
        }
      }),
      harness.defineTool({
        name: 'vision_measure',
        description: '几何测量:输入两个位置(各为 {box?|point?|cell?}),返回两中心点的像素距离、水平/垂直位移与夹角(度);只给 a 时返回 a 的面积。',
        parameters: {
          frame_id: { type: 'string', description: '帧 ID,省略为当前帧' },
          a: { type: 'json', required: true, description: '{box?|point?|cell?} 位置 A' },
          b: { type: 'json', description: '{box?|point?|cell?} 位置 B,省略则只测 A 面积' }
        },
        output: JSON_OUT,
        execute(args) {
          const f = getFrame(args.frame_id)
          const pa = posOf(f, args.a)
          if (!args.b) {
            return { area: (pa.box[2] - pa.box[0]) * (pa.box[3] - pa.box[1]), box: pa.box }
          }
          const pb = posOf(f, args.b)
          const dx = pb.point[0] - pa.point[0]
          const dy = pb.point[1] - pa.point[1]
          const dist = Math.sqrt(dx * dx + dy * dy)
          const deg = Math.atan2(dy, dx) * 180 / Math.PI
          return { distance_px: Math.round(dist * 100) / 100, dx, dy, angle_deg: Math.round(deg * 100) / 100, a: pa, b: pb }
        }
      }),
      harness.defineTool({
        name: 'vision_diff',
        description: '帧间差分(确定性变化检测):比较两帧(不指定 other_frame_id 时自动重新截取全屏与当前帧对比),返回变化像素包围盒 bbox、变化像素数与比例,并保存高亮变化区域的图片。用于场景变化检测:前后两次截帧 diff 即可精确得知哪里变了。',
        parameters: {
          frame_id: { type: 'string', description: '基准帧,默认当前帧' },
          other_frame_id: { type: 'string', description: '对比帧,默认自动重新截屏' },
          region: { type: 'array', items: { type: 'number' }, description: '只比较该区域 [x1,y1,x2,y2](帧像素)' },
          threshold: { type: 'integer', description: '像素变化阈值(RGB 差之和),默认 40' }
        },
        output: JSON_OUT,
        timeoutMs: 30000,
        async execute(args, exec) {
          const f = getFrame(args.frame_id)
          let other = args.other_frame_id ? state.frames[args.other_frame_id] : null
          let freshPath = null
          if (!other) {
            if (!f.origin) throw new Error('frame is not screen-based; provide other_frame_id')
            const info = await ensureScreenInfo(exec.signal)
            const path = `${framesDir}/diff-cap-${state.seq + 1}.png`
            const res = await psRun('capture', { path, region: [info.bounds[0], info.bounds[1], info.bounds[2], info.bounds[3]] }, exec.signal)
            other = decodePng(await readBytesNative(res.path, 96 * 1024 * 1024))
            freshPath = res.path
          }
          const d = diffFrames(f, other, args.region, args.threshold)
          const img = { width: f.width, height: f.height, data: f.data.slice() }
          for (let y = 0; y < img.height; y++) {
            for (let x = 0; x < img.width; x++) {
              if (d.changed[y * img.width + x]) {
                const dd = (y * img.width + x) * 4
                img.data[dd] = 255
                img.data[dd + 1] = 30
                img.data[dd + 2] = 30
              }
            }
          }
          const path = `${framesDir}/diff-${f.id}-${state.seq + 1}.png`
          await savePngNative(path, img)
          return { changed_pixels: d.count, sampled_pixels: d.sampled, ratio: Math.round(d.ratio * 1000) / 1000, bbox: d.bbox, path, fresh_capture: freshPath }
        }
      }),
      harness.defineTool({
        name: 'vision_find_color',
        description: '传统 CV 颜色分割精定位(像素级,确定性):在帧内按颜色(名称/近似色/区间)做阈值分割与连通域分析,返回面积最大的若干色块(包围盒+质心+屏幕坐标),并保存编号标注图。适合纯色 UI 元素(按钮/徽标/图标)的确定性定位,或作为视觉定位后的像素级精修。',
        parameters: {
          frame_id: { type: 'string', description: '帧 ID,省略为当前帧' },
          color: { type: 'string', required: true, description: "'red'|'green'|'blue'|'yellow'|'orange'|'purple'|'cyan'|'magenta'|'white'|'black'|'gray' 或 [r,g,b] 或区间 [r1,g1,b1,r2,g2,b2]" },
          region: { type: 'array', items: { type: 'number' }, description: '限定搜索区域 [x1,y1,x2,y2](帧像素)' },
          tolerance: { type: 'integer', description: '近似色容差(每通道),默认 32' },
          min_area: { type: 'integer', description: '最小面积(像素),默认 16' },
          max_results: { type: 'integer', description: '最多返回几个色块,默认 8' }
        },
        output: JSON_OUT,
        timeoutMs: 30000,
        async execute(args) {
          const f = getFrame(args.frame_id)
          const comps = findColor(f, args.color, args.region, args.tolerance, args.min_area, args.max_results)
          const img = { width: f.width, height: f.height, data: f.data.slice() }
          comps.forEach((c, i) => {
            putRect(img, c.box, [255, 90, 40], 2)
            putText(img, String(i + 1), c.box[0] + 2, c.box[1] + 2, 2, [255, 90, 40])
          })
          const path = `${framesDir}/color-${f.id}-${state.seq + 1}.png`
          await savePngNative(path, img)
          for (const c of comps) {
            const sc = frameToScreen(f.id, c.center[0], c.center[1])
            if (sc) c.screen_center = [Math.round(sc.x), Math.round(sc.y)]
          }
          return { path, frame_id: f.id, count: comps.length, components: comps }
        }
      }),
      harness.defineTool({
        name: 'vision_ocr',
        description: 'Windows 原生 OCR(WinRT OcrEngine,经 Host subprocess):识别帧(或帧内区域)中的文字,返回每个词的文本框与中心坐标(帧像素+屏幕坐标)。用于"文本锚定"式定位:找到目标文字 -> 取中心 -> 得到精确坐标。',
        parameters: {
          frame_id: { type: 'string', description: '帧 ID,省略为当前帧' },
          region: { type: 'array', items: { type: 'number' }, description: '只识别该区域 [x1,y1,x2,y2](帧像素)' }
        },
        output: JSON_OUT,
        timeoutMs: 45000,
        async execute(args, exec) {
          const f = getFrame(args.frame_id)
          let img = f
          let ox = 0
          let oy = 0
          if (Array.isArray(args.region) && args.region.length === 4) {
            const box = clampBox(args.region, f.width, f.height)
            img = crop(f, box)
            ox = box[0]
            oy = box[1]
          }
          const tempPath = `${framesDir}/ocr-tmp-${state.seq + 1}.png`
          await savePngNative(tempPath, img)
          const res = await psRun('ocr', { path: tempPath }, exec.signal)
          const words = (res.words || []).map((w) => {
            const box = [w.box[0] + ox, w.box[1] + oy, w.box[2] + ox, w.box[3] + oy]
            const center = [Math.round((box[0] + box[2]) / 2), Math.round((box[1] + box[3]) / 2)]
            const sc = frameToScreen(f.id, center[0], center[1])
            return { text: w.text, box, center, screen_center: sc ? [Math.round(sc.x), Math.round(sc.y)] : null }
          })
          return { frame_id: f.id, count: words.length, words }
        }
      }),
      harness.defineTool({
        name: 'vision_describe',
        description: '调用 MiMo v2.5 多模态模型(native:经 Host subprocess 派生 node 子进程直连 Xiaomi MiMo API)描述当前帧内容。帧自动缩放至 max_edge 后以 base64 发送,返回模型文字描述。解决当前智能体模型无图像输入时的"看图"问题。',
        parameters: {
          frame_id: { type: 'string', description: '帧 ID,省略为当前帧' },
          question: { type: 'string', description: '针对性问题,省略则整体描述' },
          max_edge: { type: 'integer', description: '发送图像最长边像素,默认 1024,范围 320-2048' }
        },
        output: JSON_OUT,
        timeoutMs: 120000,
        async execute(args, exec) {
          const f = getFrame(args.frame_id)
          const maxEdge = clampInt(args.max_edge, 320, 2048, 1024)
          const img = downscale(f, maxEdge)
          const messages = [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: frameDataUrl(img) } },
              { type: 'text', text: (args.question || '请详细描述这张图片的内容,包括可见的界面元素、文字和布局。') + ` 图像尺寸 ${f.width}x${f.height}(发送时可能已缩放)。` }
            ]
          }]
          const msg = await mimoChat(messages, exec.signal)
          return { frame_id: f.id, model: cfgModel(), answer: msg.content }
        }
      }),
      harness.defineTool({
        name: 'vision_locate',
        description: '调用 MiMo v2.5 视觉定位目标:给出目标文字描述,模型返回像素包围盒(缩放坐标自动反算回原帧,并换算绝对屏幕坐标)。结果写入定位锚点(grounding)并保存标注图。这是多模态"看图定位"的核心原语,配合 vision_zoom 可迭代精修。',
        parameters: {
          frame_id: { type: 'string', description: '帧 ID,省略为当前帧' },
          target: { type: 'string', required: true, description: '目标描述,如:右上角的关闭按钮 / 左侧输入框 / 红色图标' }
        },
        output: JSON_OUT,
        timeoutMs: 120000,
        async execute(args, exec) {
          const f = getFrame(args.frame_id)
          const maxEdge = 1280
          const img = downscale(f, maxEdge)
          const s = Math.max(1, Math.ceil(Math.max(f.width, f.height) / maxEdge))
          const prompt = `你是精确的视觉定位助手。请在这张图片中找到目标:「${args.target}」。只输出一行 JSON:{"found":true或false,"box":[x1,y1,x2,y2],"label":"目标简短名称"}。坐标必须是整数像素,box 是目标的紧致包围盒,不要输出任何其它文字。图像尺寸 ${img.width}x${img.height}。`
          const messages = [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: frameDataUrl(img) } },
              { type: 'text', text: prompt }
            ]
          }]
          const msg = await mimoChat(messages, exec.signal)
          const raw = msg.content || ''
          let parsed = null
          const m = raw.match(/\{[\s\S]*?"found"[\s\S]*?\}/)
          if (m) { try { parsed = JSON.parse(m[0]) } catch (e) { parsed = null } }
          if (!parsed || parsed.found === false) {
            return { frame_id: f.id, found: false, raw: raw.slice(0, 1000), note: 'MiMo 未找到目标;可尝试更换描述或先 vision_zoom 缩小搜索区域后重试' }
          }
          const boxSent = clampBox(parsed.box, img.width, img.height)
          const box = clampBox([boxSent[0] * s, boxSent[1] * s, boxSent[2] * s, boxSent[3] * s], f.width, f.height)
          const center = [Math.round((box[0] + box[2]) / 2), Math.round((box[1] + box[3]) / 2)]
          const sc = frameToScreen(f.id, center[0], center[1])
          state.grounding = { frameId: f.id, point: center, box }
          const ann = { width: f.width, height: f.height, data: f.data.slice() }
          putRect(ann, box, [255, 40, 40], 3)
          putText(ann, parsed.label || args.target, box[0], Math.max(0, box[1] - 8), 2, [255, 40, 40])
          const path = `${framesDir}/locate-${f.id}-${state.seq + 1}.png`
          await savePngNative(path, ann)
          return { frame_id: f.id, found: true, label: parsed.label || null, box, center, screen_point: sc ? [Math.round(sc.x), Math.round(sc.y)] : null, path, raw: raw.slice(0, 500) }
        }
      }),
      harness.defineTool({
        name: 'vision_analyze',
        description: '视觉证据协议(VEP): 把当前帧/图片文本化为"模型间可视化交流语言"。MiMo 先内部思考(草稿默认不返回)再结构化输出: caption(自然语言语义描述) + layout(布局概述) + elements(重要元素列表)。每个元素带归一化 box(0-1000)、像素 box、中心点、所属 SOM 4x4 格子编号(结果已写入会话网格, 可直接 vision_resolve(cell=N) 拿精确坐标)。这是纯文本模型"看懂图片"的主入口, 也是聊天框贴图的底层引擎。',
        parameters: {
          frame_id: { type: 'string', description: '帧 ID, 省略为当前帧' },
          path: { type: 'string', description: '工作区图片绝对路径(无帧时用), 与 frame_id 二选一' },
          maxElements: { type: 'integer', description: '最多识别的元素数, 默认 8, 范围 1-16' },
          includeReasoning: { type: 'boolean', description: '附带 MiMo 推理草稿(默认 false)' }
        },
        output: JSON_OUT,
        timeoutMs: 180000,
        async execute(args, exec) {
          let f = null
          let img = null
          if (args.frame_id !== undefined) {
            f = getFrame(args.frame_id)
            img = { width: f.width, height: f.height, data: f.data }
          } else if (typeof args.path === 'string' && args.path.length > 0) {
            img = await loadPngNative(args.path)
            const id = newFrame(args.path, img.width, img.height, img.data, null, null)
            f = state.frames[id]
          } else {
            throw new Error('frame_id 与 path 至少给一个')
          }
          const maxElements = clampInt(args.maxElements, 1, 16, 8)
          const maxEdge = 1600
          const imgSent = downscale(img, maxEdge)
          const s = Math.max(1, Math.ceil(Math.max(img.width, img.height) / maxEdge))
          const analysis = await analyzeImageCore(imgSent, maxElements, exec.signal)
          if (!analysis.ok) return analysis
          // 确定性后处理: 归一化 box → 像素/中心/SOM 格子; 网格写入会话供 vision_resolve 直接解析
          const cells = gridCellsOf(f.width, f.height, 4, 4)
          state.grids[f.id] = { rows: 4, cols: 4, cells, path: null }
          const elements = analysis.elements.map((el) => attachGeometry(el, img, f.id, cells))
          const out = {
            ok: true,
            frame_id: f.id,
            path: f.path,
            width: f.width,
            height: f.height,
            caption: analysis.caption,
            layout: analysis.layout,
            elements,
            note: 'elements 中的 grid_cell 已写入会话网格, 可直接 vision_resolve(cell=N) 获取该元素的精确像素/屏幕坐标'
          }
          if (analysis.reasoning && args.includeReasoning === true) out.reasoning = analysis.reasoning
          return out
        }
      }),
      harness.defineTool({
        name: 'vision_state',
        description: '查看视觉会话状态:帧列表(尺寸/来源/缩放映射链)、当前帧、最近定位锚点、各帧网格与屏幕信息。',
        parameters: {},
        output: JSON_OUT,
        async execute() {
          try { await ensureReady() } catch (e) { /* 保留 psExe 为 null 并继续返回状态 */ }
          const frames = state.order.map((id) => {
            const f = state.frames[id]
            return {
              id: f.id,
              path: f.path,
              width: f.width,
              height: f.height,
              origin: f.origin,
              base: f.base ? { frameId: f.base.frameId, box: f.base.box, scale: f.base.scale } : null
            }
          })
          return {
            current: state.current,
            frames,
            grounding: state.grounding,
            grids: Object.keys(state.grids).map((id) => ({ frame_id: id, rows: state.grids[id].rows, cols: state.grids[id].cols, path: state.grids[id].path })),
            screen: state.screenInfo,
            helper: { exe: psExe, store: storeDir }
          }
        }
      }),
      harness.defineTool({
        name: 'vision_reset',
        description: '清空全部视觉会话状态(帧/网格/定位锚点),保留插件运行。',
        parameters: {},
        output: JSON_OUT,
        execute() {
          for (const id of Object.keys(state.frames)) delete state.frames[id]
          state.order = []
          state.current = null
          state.grounding = null
          state.grids = {}
          return { ok: true }
        }
      })
    ]

    /* MiMo provider + 适配器 + 默认模型选择 + 凭据落库 */
    const llmSvc = ctx.get('llm')
    if (llmSvc !== undefined) {
      ctx.effect(() => llmSvc.registerAdapter(['mimo'], MIMO_ADAPTER))
    } else {
      console.error('mimo: llm service unavailable; adapter not registered')
    }
    // 发布版不写入任何密钥, 也不改动用户的默认模型。
    // MIMO_API_KEY 由用户在 DSH credentials 中提供:
    //   dsh credentials set MIMO_API_KEY <key>
    // 运行时由 getMimoKey() 惰性读取; 未配置时相关工具会给出明确报错。

    /* ---------- 聊天框图片粘贴 → 路径/证据文本 (paste-to-path, 社区解法) ----------
     * 参考 liustack/modlens 的 paste-to-path 模式, 原生实现:
     *  - Client 在捕获阶段截获剪贴板图片, POST 到本路由; 返回的路径
     *    (及可选的 MiMo 自动摘要) 作为纯文本插入输入框;
     *  - 视觉模型 (mimo-v2.5 等 inputModalities 含 image) 保持原生图片
     *    附件, 不被劫持;
     *  - 纯文本模型 (如 deepseek) 由此获得"贴图"能力 —— 不再触发
     *    "model does not support images" 报错, 模型看到的是文件路径
     *    + 自动生成的图片内容摘要, 可继续用 read_image/vision_* 处理。
     * 开关: 配置 pasteToPath=false 时 GET 返回 404, 客户端完全让行。 */
    const webServerSvc = ctx.get('webServer')
    const admVerdict = ctx.get('agentDefaultModel')
    const pasteEnabled = () => (liveConfig && liveConfig.pasteToPath !== false)
    const pasteAutoDescribe = () => (liveConfig && liveConfig.autoDescribe !== false)
    async function currentModelSupportsImage() {
      try {
        const sel = admVerdict ? await Promise.resolve(admVerdict.currentSelection()) : undefined
        if (sel && sel.provider && sel.model && llmSvc !== undefined) {
          const info = await llmSvc.resolveModelInfo(sel.provider, sel.model)
          const mods = (info && info.inputModalities) || []
          return mods.indexOf('image') >= 0
        }
      } catch (e) { /* fall through */ }
      return false
    }
    function pasteExtOf(mime) {
      const m = (mime || '').toLowerCase()
      if (m.indexOf('png') >= 0) return '.png'
      if (m.indexOf('jpeg') >= 0 || m.indexOf('jpg') >= 0) return '.jpg'
      if (m.indexOf('webp') >= 0) return '.webp'
      if (m.indexOf('gif') >= 0) return '.gif'
      if (m.indexOf('bmp') >= 0) return '.bmp'
      return '.png'
    }
    function collectReqBytes(req, maxBytes) {
      return new Promise((resolve, reject) => {
        const chunks = []
        let total = 0
        let settled = false
        req.on('data', (c) => {
          if (settled) return
          total += c.length
          if (total > maxBytes) {
            settled = true
            reject(new Error('paste image exceeds ' + maxBytes + ' bytes'))
            try { req.destroy() } catch (e) {}
            return
          }
          chunks.push(c)
        })
        req.on('end', () => {
          if (settled) return
          settled = true
          const out = new Uint8Array(total)
          let off = 0
          for (const c of chunks) { out.set(c, off); off += c.length }
          resolve(out)
        })
        req.on('error', (e) => {
          if (settled) return
          settled = true
          reject(e)
        })
      })
    }
    /* 贴图分析(视觉证据协议 quick 模式): PNG 可解码时注册为会话帧并做
       完整几何映射(像素/SOM 格子), 否则 data URL 直发仅保留归一化 box。 */
    async function analyzePastedImage(bytes, mime, frameId) {
      let img = null
      try { img = decodePng(bytes) } catch (e) { img = null }
      if (img) {
        const analysis = await analyzeImageCore(img, 4, undefined)
        if (!analysis.ok) return analysis
        const cells = gridCellsOf(img.width, img.height, 4, 4)
        if (frameId) state.grids[frameId] = { rows: 4, cols: 4, cells, path: null }
        const elements = analysis.elements.map((el) => attachGeometry(el, img, frameId || null, cells))
        return { ok: true, caption: analysis.caption, layout: analysis.layout, elements }
      }
      // 非 PNG(JPEG/WebP 等): 直接发 data URL, 保留归一化坐标(0-1000)
      const dataUrl = 'data:' + (mime || 'image/png') + ';base64,' + b64encode(bytes)
      return analyzeImageCore({ width: 1000, height: 1000 }, 4, undefined, dataUrl)
    }
    if (webServerSvc !== undefined) {
      ctx.effect(() => webServerSvc.register({
        kind: 'prefix',
        path: '/vision-primitives/paste',
        handler: async (req, res) => {
          try {
            const u = new URL(req.url || '/', 'http://x')
            if (req.method === 'GET') {
              if (!pasteEnabled()) { res.writeHead(404); res.end(); return }
              let takeover = true
              const label = u.searchParams.get('model') || ''
              if (label && /mimo/i.test(label)) takeover = false
              else takeover = !(await currentModelSupportsImage())
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ takeover }))
              return
            }
            if (req.method === 'POST') {
              if (!pasteEnabled()) { res.writeHead(404); res.end(); return }
              const mime = u.searchParams.get('type') || 'image/png'
              const bytes = await collectReqBytes(req, 64 * 1024 * 1024)
              const path = `${storeDir}/paste-${Date.now()}-${++psSeq}${pasteExtOf(mime)}`
              await psRun('write', { path, data: b64encode(bytes) })
              let frameId = null
              try {
                const img = decodePng(bytes)
                frameId = newFrame(path, img.width, img.height, img.data, null, null)
              } catch (e) { frameId = null }
              const out = { path, ...(frameId ? { frame_id: frameId } : {}) }
              if (pasteAutoDescribe()) {
                try {
                  out.analysis = await analyzePastedImage(bytes, mime, frameId)
                } catch (e) {
                  out.analysis = { ok: false, note: String((e && e.message) || e) }
                }
              }
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify(out))
              return
            }
            res.writeHead(404)
            res.end()
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: String((e && e.message) || e) }))
          }
        }
      }), 'vision-primitives: paste route')
    }

    ctx.effect(() => {
      const disposers = TOOLS.map((t) => harness.registerTool(ctx, t))
      return () => {
        for (const d of disposers) d()
      }
    })
  }
}
