function clampChannel(value) {
  return Math.min(255, Math.max(0, Math.round(value)))
}

/**
 * 沿笔刷外圈采样，用于估算周边底色及其渐变方向。
 */
function collectRingSamples(
  pixels,
  width,
  height,
  centerX,
  centerY,
  radius,
  sampleCount
) {
  const outer = radius + 5
  const count = Math.max(8, sampleCount || 64)
  const points = []
  let r = 0
  let g = 0
  let b = 0
  let a = 0

  for (let i = 0; i < count; i += 1) {
    const angle = (Math.PI * 2 * i) / count
    const x = Math.round(centerX + Math.cos(angle) * outer)
    const y = Math.round(centerY + Math.sin(angle) * outer)
    if (x < 0 || y < 0 || x >= width || y >= height) continue
    const offset = (y * width + x) * 4
    const point = {
      x: x,
      y: y,
      r: pixels[offset],
      g: pixels[offset + 1],
      b: pixels[offset + 2],
      a: pixels[offset + 3]
    }
    points.push(point)
    r += point.r
    g += point.g
    b += point.b
    a += point.a
  }

  const total = Math.max(1, points.length)
  return {
    points: points,
    average: [
      Math.round(r / total),
      Math.round(g / total),
      Math.round(b / total),
      Math.round(a / total)
    ]
  }
}

/**
 * 最小二乘拟合 value = a * x + b * y + c。
 * 先把坐标平移到样本中心再解正规方程；直接用 0..900 的原始坐标会让方程病态，
 * 行列式接近 0 时（样本共线）返回 null，由调用方退化为均值填充。
 */
function fitPlane(points, channel) {
  const count = points ? points.length : 0
  if (count < 8) return null

  let meanX = 0
  let meanY = 0
  let meanValue = 0
  for (let i = 0; i < count; i += 1) {
    meanX += points[i].x
    meanY += points[i].y
    meanValue += points[i][channel]
  }
  meanX /= count
  meanY /= count
  meanValue /= count

  let sxx = 0
  let syy = 0
  let sxy = 0
  let sxv = 0
  let syv = 0
  for (let i = 0; i < count; i += 1) {
    const x = points[i].x - meanX
    const y = points[i].y - meanY
    const value = points[i][channel] - meanValue
    sxx += x * x
    syy += y * y
    sxy += x * y
    sxv += x * value
    syv += y * value
  }

  const determinant = sxx * syy - sxy * sxy
  if (sxx <= 0 || syy <= 0) return null
  if (Math.abs(determinant) <= 1e-9 * sxx * syy) return null

  const a = (sxv * syy - syv * sxy) / determinant
  const b = (syv * sxx - sxv * sxy) / determinant
  return [a, b, meanValue - a * meanX - b * meanY]
}

/**
 * 生成一次笔刷修复的像素补丁。
 * 返回 { left, top, width, height, data }，data 已包含圆形范围外的原始像素，
 * 调用方可以直接 putImageData，不会把角落写成透明。
 */
function buildRepairPatch(
  pixels,
  width,
  height,
  centerX,
  centerY,
  radius,
  sampleCount
) {
  const cx = Math.round(centerX)
  const cy = Math.round(centerY)
  if (cx < 0 || cy < 0 || cx >= width || cy >= height) return null

  const safeRadius = Math.max(1, Number(radius) || 0)
  const ring = collectRingSamples(
    pixels,
    width,
    height,
    cx,
    cy,
    safeRadius,
    sampleCount
  )
  if (!ring.points.length) return null

  const reach = Math.ceil(safeRadius)
  const left = Math.max(0, cx - reach)
  const top = Math.max(0, cy - reach)
  const right = Math.min(width, cx + reach + 1)
  const bottom = Math.min(height, cy + reach + 1)
  const patchWidth = right - left
  const patchHeight = bottom - top
  if (patchWidth <= 0 || patchHeight <= 0) return null

  const data = new Uint8ClampedArray(patchWidth * patchHeight * 4)
  for (let y = 0; y < patchHeight; y += 1) {
    for (let x = 0; x < patchWidth; x += 1) {
      const sourceOffset = ((top + y) * width + (left + x)) * 4
      const patchOffset = (y * patchWidth + x) * 4
      data[patchOffset] = pixels[sourceOffset]
      data[patchOffset + 1] = pixels[sourceOffset + 1]
      data[patchOffset + 2] = pixels[sourceOffset + 2]
      data[patchOffset + 3] = pixels[sourceOffset + 3]
    }
  }

  const planes = [
    fitPlane(ring.points, 'r'),
    fitPlane(ring.points, 'g'),
    fitPlane(ring.points, 'b')
  ]
  const average = ring.average
  const falloff = Math.max(1, safeRadius * 0.18)

  for (let y = 0; y < patchHeight; y += 1) {
    const imageY = top + y
    for (let x = 0; x < patchWidth; x += 1) {
      const imageX = left + x
      const distance = Math.hypot(imageX - cx, imageY - cy)
      if (distance > safeRadius) continue
      const blend = Math.min(1, (safeRadius - distance) / falloff)
      if (blend <= 0) continue

      const sourceOffset = (imageY * width + imageX) * 4
      const patchOffset = (y * patchWidth + x) * 4
      for (let channel = 0; channel < 3; channel += 1) {
        const plane = planes[channel]
        const restored = plane
          ? clampChannel(
              plane[0] * imageX + plane[1] * imageY + plane[2]
            )
          : average[channel]
        const original = pixels[sourceOffset + channel]
        data[patchOffset + channel] = Math.round(
          original * (1 - blend) + restored * blend
        )
      }
    }
  }

  return {
    left: left,
    top: top,
    width: patchWidth,
    height: patchHeight,
    data: data
  }
}

module.exports = {
  buildRepairPatch,
  clampChannel,
  collectRingSamples,
  fitPlane
}
