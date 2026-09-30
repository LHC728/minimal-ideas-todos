/**
 * 生成 PWA 图标（无第三方依赖）。
 *
 * 图形语言与 APP 一致：低饱和强调色 + 一个「灯泡」符号，
 * 不做渐变、不做霓虹、不做毛玻璃（§68）。
 *
 * 用法：node scripts/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '..', 'public', 'icons')

const ACCENT = [0xb8, 0x84, 0x3f]
const PAPER = [0xfc, 0xfc, 0xfb]
const WHITE = [0xff, 0xff, 0xff]

// ---------- 几何 SDF ----------

function sdRoundedBox(px, py, hw, hh, r) {
  const qx = Math.abs(px) - (hw - r)
  const qy = Math.abs(py) - (hh - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r
}

function coverage(sd, softness) {
  return Math.min(1, Math.max(0, 0.5 - sd / softness))
}

// ---------- 绘制 ----------

function blend(dst, i, color, alpha) {
  if (alpha <= 0) return
  const a = Math.min(1, alpha)
  for (let c = 0; c < 3; c += 1) {
    dst[i + c] = Math.round(dst[i + c] * (1 - a) + color[c] * a)
  }
  dst[i + 3] = Math.round(dst[i + 3] * (1 - a) + 255 * a)
}

/**
 * @param {number} size
 * @param {{ maskable?: boolean }} options
 */
function renderIcon(size, options = {}) {
  const maskable = options.maskable === true
  const rgba = Buffer.alloc(size * size * 4, 0)
  const ss = 3 // 3x3 超采样
  const softness = (1 / size) * 1.6

  // 普通图标：浅底 + 强调色符号；maskable：强调色满铺 + 白色符号
  const bgColor = maskable ? ACCENT : PAPER
  const glyphColor = maskable ? WHITE : ACCENT

  // 遮罩安全区：maskable 需要把图形收在中心 ~60%
  const glyphScale = maskable ? 0.62 : 1

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let bgA = 0
      let bulbA = 0
      let neckA = 0
      let baseA = 0

      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const u = (x + (sx + 0.5) / ss) / size
          const v = (y + (sy + 0.5) / ss) / size

          // 背景：maskable 满铺，普通图标为圆角方块
          if (maskable) {
            bgA += 1
          } else {
            bgA += coverage(sdRoundedBox(u - 0.5, v - 0.5, 0.5, 0.5, 0.22), softness)
          }

          const cu = (u - 0.5) / glyphScale + 0.5
          const cv = (v - 0.5) / glyphScale + 0.5
          const gs = softness * (1 / glyphScale)

          // 灯泡：球体 + 颈部 + 底座
          bulbA += coverage(sdCircle(cu, cv, 0.5, 0.405, 0.15), gs)
          neckA += coverage(sdRoundedBox(cu - 0.5, cv - 0.575, 0.056, 0.055, 0.02), gs)
          baseA += coverage(sdRoundedBox(cu - 0.5, cv - 0.646, 0.042, 0.024, 0.021), gs)
        }
      }

      const n = ss * ss
      const i = (y * size + x) * 4
      blend(rgba, i, bgColor, bgA / n)
      blend(rgba, i, glyphColor, bulbA / n)
      blend(rgba, i, glyphColor, neckA / n)
      blend(rgba, i, glyphColor, baseA / n)
    }
  }

  return rgba
}

// ---------- 最小 PNG 编码器 ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crcBuf])
}

function encodePng(size, rgba) {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function write(name, size, options) {
  const file = resolve(outDir, name)
  writeFileSync(file, encodePng(size, renderIcon(size, options)))
  console.log(`generated ${name} (${size}x${size})`)
}

mkdirSync(outDir, { recursive: true })

write('icon-192.png', 192, {})
write('icon-512.png', 512, {})
write('maskable-512.png', 512, { maskable: true })
write('apple-touch-icon.png', 180, {})
write('favicon-32.png', 32, {})
