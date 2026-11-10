/**
 * 手动修正遮罩：记录用户在抠图结果上涂抹过的像素。
 * 0 = 不干预，1 = 强制保留主体，2 = 强制移除。
 * 遮罩与照片同尺寸，每像素一字节，比直接存整张 RGBA 省四分之三内存。
 */
const MASK_KEEP = 1
const MASK_ERASE = 2

function createMask(width, height) {
  if (!width || !height) return new Uint8Array(0)
  return new Uint8Array(width * height)
}

function clearMask(mask) {
  if (mask) mask.fill(0)
}

/**
 * 在遮罩上盖一个圆点，返回被改动的像素数。
 * 圆的边缘不做抗锯齿：遮罩只决定要不要覆盖，过渡交给羽化。
 */
function paintCircle(mask, width, height, centerX, centerY, radius, value) {
  if (!mask || !width || !height) return 0
  const size = Math.max(1, Math.round(radius))
  const minX = Math.max(0, Math.floor(centerX - size))
  const maxX = Math.min(width - 1, Math.ceil(centerX + size))
  const minY = Math.max(0, Math.floor(centerY - size))
  const maxY = Math.min(height - 1, Math.ceil(centerY + size))
  const limitSq = size * size
  let changed = 0

  for (let y = minY; y <= maxY; y += 1) {
    const dy = y - centerY
    const row = y * width
    const dySq = dy * dy
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - centerX
      if (dx * dx + dySq > limitSq) continue
      const index = row + x
      if (mask[index] === value) continue
      mask[index] = value
      changed += 1
    }
  }

  return changed
}

/**
 * 把遮罩叠加到抠图结果的 alpha 上，返回被改动的像素数。
 * 只动 alpha：结果的 RGB 本来就是原图像素，恢复时可以直接使用。
 */
function applyMask(imageData, mask) {
  if (!imageData || !imageData.data || !mask) return 0
  const data = imageData.data
  const pixelCount = Math.min(mask.length, data.length >> 2)
  let applied = 0

  for (let index = 0; index < pixelCount; index += 1) {
    const target = mask[index]
    if (!target) continue
    const offset = index * 4 + 3
    const alpha = target === MASK_ERASE ? 0 : 255
    if (data[offset] !== alpha) {
      data[offset] = alpha
      applied += 1
    }
  }

  return applied
}

function countPainted(mask) {
  if (!mask) return 0
  let painted = 0
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index]) painted += 1
  }
  return painted
}

/**
 * 触控点换算：CSS 像素 → 照片像素。
 * pixelRatio 是画布缓冲区相对 CSS 尺寸的倍数，scale 是缓冲区像素 ÷ 照片像素。
 */
function toPhotoPoint(offsetX, offsetY, pixelRatio, scale) {
  if (!pixelRatio || !scale) return null
  return {
    x: (offsetX * pixelRatio) / scale,
    y: (offsetY * pixelRatio) / scale
  }
}

module.exports = {
  MASK_ERASE,
  MASK_KEEP,
  applyMask,
  clearMask,
  countPainted,
  createMask,
  paintCircle,
  toPhotoPoint
}
