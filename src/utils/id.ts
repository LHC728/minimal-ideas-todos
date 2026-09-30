/** UUID v4 —— Record 与 Mutation 的 ID 必须由客户端生成（方案 §33） */

export function uuidv4(): string {
  const cryptoObj = globalThis.crypto
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID()
  }
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    cryptoObj.getRandomValues(bytes)
    // RFC 4122 §4.4：把版本位改成 4、变体位改成 10xx。
    // Uint8Array(16) 长度由字面量固定，索引 6 / 8 必然存在 ——
    // 这里的 ! 表达的是「长度已由字面量保证」，不是「我猜它存在」。
    bytes[6] = ((bytes[6]! & 0x0f) | 0x40)
    bytes[8] = ((bytes[8]! & 0x3f) | 0x80)
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  // 极端兜底（非安全场景）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
