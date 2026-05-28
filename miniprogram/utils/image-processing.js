function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function colorDistanceSq(a, b) {
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  return dr * dr + dg * dg + db * db
}

// 加权 RGB 距离，比等权欧氏距离更接近人眼对亮度和色偏的感知。
function perceptualColorDistanceSq(a, b) {
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  return dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11
}

// Uint16 足够存放 900×1200 图像的距离场，比 Float32 省一半内存；
// 上限留出 1 的余量，避免 +1 时回绕。
const DISTANCE_CEILING = 65534

function buildDistanceField(width, height, isBackground, target) {
  const pixelCount = width * height
  const distance =
    target && target.length === pixelCount
      ? target
      : new Uint16Array(pixelCount)
  const infinity = Math.min(DISTANCE_CEILING, width + height + 4)

  for (let index = 0; index < pixelCount; index += 1) {
    distance[index] = isBackground[index] ? 0 : infinity
  }

  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      const index = row + x
      if (x > 0) {
        distance[index] = Math.min(
          distance[index],
          distance[index - 1] + 1
        )
      }
      if (y > 0) {
        distance[index] = Math.min(
          distance[index],
          distance[index - width] + 1
        )
      }
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    const row = y * width
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = row + x
      if (x + 1 < width) {
        distance[index] = Math.min(
          distance[index],
          distance[index + 1] + 1
        )
      }
      if (y + 1 < height) {
        distance[index] = Math.min(
          distance[index],
          distance[index + width] + 1
        )
      }
    }
  }

  return distance
}

/**
 * 在初始分割结果上做距离场羽化，并对半透明边缘去背景色污染。
 * output 缓冲可复用，避免每次渲染都重新分配整张图像。
 */
function refineCutoutAlpha(
  imageData,
  isBackground,
  backgrounds,
  tolerance,
  featherRadius,
  scratch
) {
  const width = imageData.width
  const height = imageData.height
  const pixelCount = width * height
  const source = imageData.data
  const reusable = scratch || {}
  const output =
    reusable.output instanceof Uint8ClampedArray &&
    reusable.output.length === source.length
      ? reusable.output
      : new Uint8ClampedArray(source.length)
  output.set(source)
  // 0 是有效值（锐利边缘），只有未传参数时才用默认羽化。
  const requestedRadius = Number(featherRadius)
  const radius = clamp(
    Number.isFinite(requestedRadius) ? Math.round(requestedRadius) : 3,
    0,
    12
  )
  const background = backgrounds[0] || [255, 255, 255]
  const distance = buildDistanceField(
    width,
    height,
    isBackground,
    reusable.distance
  )
  const edgeLimitSq = (tolerance + 26) * (tolerance + 26) * 3

  for (let index = 0; index < pixelCount; index += 1) {
    const currentDistance = distance[index]
    const offset = index * 4
    if (currentDistance === 0) {
      output[offset + 3] = 0
      continue
    }
    if (currentDistance > radius) continue

    // 逐像素直接算加权距离，避免为每个像素分配临时数组。
    const red = source[offset]
    const green = source[offset + 1]
    const blue = source[offset + 2]
    let closest = Infinity
    for (let i = 0; i < backgrounds.length; i += 1) {
      const candidate = backgrounds[i]
      const dr = red - candidate[0]
      const dg = green - candidate[1]
      const db = blue - candidate[2]
      const distanceSq = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11
      if (distanceSq < closest) closest = distanceSq
    }

    const colorT = clamp(Math.sqrt(closest / edgeLimitSq), 0, 1)
    const distanceT = clamp(currentDistance / (radius + 1), 0, 1)
    const alpha = Math.round(255 * Math.max(colorT, distanceT * 0.5))
    output[offset + 3] = Math.min(output[offset + 3], alpha)

    if (alpha > 0 && alpha < 255) {
      const a = alpha / 255
      const inverse = 1 - a
      output[offset] = clamp(
        (source[offset] - background[0] * inverse) / a,
        0,
        255
      )
      output[offset + 1] = clamp(
        (source[offset + 1] - background[1] * inverse) / a,
        0,
        255
      )
      output[offset + 2] = clamp(
        (source[offset + 2] - background[2] * inverse) / a,
        0,
        255
      )
    }
  }

  return output
}

/**
 * 从边缘像素聚类出候选背景色。数据为 RGBA Uint8ClampedArray。
 */
function estimateBorderColors(data, width, height) {
  if (!data || !width || !height) {
    return []
  }

  const stride = Math.max(1, Math.floor(Math.min(width, height) / 180))
  const buckets = Object.create(null)
  let total = 0

  function addPixel(x, y) {
    const index = (y * width + x) * 4
    const alpha = data[index + 3]
    if (alpha < 32) {
      return
    }

    const r = data[index]
    const g = data[index + 1]
    const b = data[index + 2]
    const key =
      Math.round(r / 16) +
      ',' +
      Math.round(g / 16) +
      ',' +
      Math.round(b / 16)
    const bucket = buckets[key] || {
      count: 0,
      r: 0,
      g: 0,
      b: 0
    }
    bucket.count += 1
    bucket.r += r
    bucket.g += g
    bucket.b += b
    buckets[key] = bucket
    total += 1
  }

  for (let x = 0; x < width; x += stride) {
    addPixel(x, 0)
    addPixel(x, height - 1)
  }
  for (let y = stride; y < height - stride; y += stride) {
    addPixel(0, y)
    addPixel(width - 1, y)
  }

  if (!total) {
    return []
  }

  return Object.keys(buckets)
    .map(function mapBucket(key) {
      const bucket = buckets[key]
      return {
        count: bucket.count,
        color: [
          Math.round(bucket.r / bucket.count),
          Math.round(bucket.g / bucket.count),
          Math.round(bucket.b / bucket.count)
        ]
      }
    })
    .sort(function sortBuckets(a, b) {
      return b.count - a.count
    })
    .filter(function filterBuckets(item, index) {
      return index === 0 || item.count / total >= 0.035
    })
    .slice(0, 5)
    .map(function returnColor(item) {
      return item.color
    })
}

/**
 * 预分配去背景所需的中间缓冲。抠图面板拖动滑杆会反复重算，
 * 复用这些缓冲可避免每次渲染都申请十几 MB 内存。
 */
function createCutoutWorkspace(width, height) {
  const pixelCount = width * height
  return {
    width: width,
    height: height,
    visited: new Uint8Array(pixelCount),
    queue: new Int32Array(pixelCount),
    distance: new Uint16Array(pixelCount)
  }
}

function resolveCutoutWorkspace(width, height, workspace) {
  const pixelCount = width * height
  if (
    workspace &&
    workspace.width === width &&
    workspace.height === height &&
    workspace.visited.length === pixelCount &&
    workspace.queue.length === pixelCount &&
    workspace.distance.length === pixelCount
  ) {
    return workspace
  }
  return createCutoutWorkspace(width, height)
}

function resolveCutoutOutput(source, target) {
  return target instanceof Uint8ClampedArray && target.length === source.length
    ? target
    : new Uint8ClampedArray(source.length)
}

/**
 * 从四边开始泛洪，仅移除与边缘连通的背景区域。
 * imageData 可为 Canvas 的 ImageData 或含 data/width/height 的普通对象。
 *
 * options.workspace 可传入上一次返回的 workspace 复用中间缓冲；
 * options.output 可传入等长的 Uint8ClampedArray 直接写入结果，
 * 适合面板拖动时反复重算的场景。
 */
function removeBackground(imageData, options) {
  const opts = options || {}
  const width = imageData.width
  const height = imageData.height
  const source = imageData.data
  const pixelCount = width * height
  const tolerance = clamp(Number(opts.tolerance) || 34, 5, 100)
  const backgrounds =
    opts.backgroundColors && opts.backgroundColors.length
      ? opts.backgroundColors
      : estimateBorderColors(source, width, height)

  if (!backgrounds.length) {
    // 无需分割时不必分配中间缓冲。
    const copy = resolveCutoutOutput(source, opts.output)
    copy.set(source)
    return {
      data: copy,
      width: width,
      height: height,
      removedPixels: 0,
      backgroundColors: [],
      workspace: opts.workspace || null
    }
  }

  const workspace = resolveCutoutWorkspace(width, height, opts.workspace)

  const visited = workspace.visited
  const queue = workspace.queue
  const thresholdSq = tolerance * tolerance * 3
  let head = 0
  let tail = 0

  // 上次渲染的 visited 标记必须清空，否则会把旧背景区域误判为已访问。
  visited.fill(0)

  function isBackground(index) {
    const offset = index * 4
    if (source[offset + 3] < 24) {
      return true
    }
    const red = source[offset]
    const green = source[offset + 1]
    const blue = source[offset + 2]
    for (let i = 0; i < backgrounds.length; i += 1) {
      const candidate = backgrounds[i]
      const dr = red - candidate[0]
      const dg = green - candidate[1]
      const db = blue - candidate[2]
      if (dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11 <= thresholdSq) {
        return true
      }
    }
    return false
  }

  function push(index) {
    if (index >= 0 && index < pixelCount && !visited[index] && isBackground(index)) {
      visited[index] = 1
      queue[tail] = index
      tail += 1
    }
  }

  for (let x = 0; x < width; x += 1) {
    push(x)
    push((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y += 1) {
    push(y * width)
    push(y * width + width - 1)
  }

  while (head < tail) {
    const index = queue[head]
    head += 1
    const x = index % width
    const y = (index - x) / width

    if (x > 0) push(index - 1)
    if (x + 1 < width) push(index + 1)
    if (y > 0) push(index - width)
    if (y + 1 < height) push(index + width)
  }

  const output = refineCutoutAlpha(
    imageData,
    visited,
    backgrounds,
    tolerance,
    opts.feather !== false ? opts.featherRadius : 0,
    {
      distance: workspace.distance,
      output: resolveCutoutOutput(source, opts.output)
    }
  )

  return {
    data: output,
    width: width,
    height: height,
    removedPixels: tail,
    backgroundColors: backgrounds,
    workspace: workspace
  }
}

function centerCropRect(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const sourceRatio = sourceWidth / sourceHeight
  const targetRatio = targetWidth / targetHeight
  if (sourceRatio > targetRatio) {
    const cropWidth = sourceHeight * targetRatio
    return {
      sx: (sourceWidth - cropWidth) / 2,
      sy: 0,
      sw: cropWidth,
      sh: sourceHeight
    }
  }
  const cropHeight = sourceWidth / targetRatio
  return {
    sx: 0,
    sy: (sourceHeight - cropHeight) / 2,
    sw: sourceWidth,
    sh: cropHeight
  }
}

function getCollageLayout(style, count, width, height, padding, gap) {
  const safeCount = clamp(Number(count) || 1, 1, 9)
  const cells = []
  const p = Number(padding) || 0
  const g = Number(gap) || 0
  const innerWidth = width - p * 2
  const innerHeight = height - p * 2

  if (style === 'vertical') {
    const cellHeight = (innerHeight - g * (safeCount - 1)) / safeCount
    for (let i = 0; i < safeCount; i += 1) {
      cells.push({
        x: p,
        y: p + i * (cellHeight + g),
        width: innerWidth,
        height: cellHeight
      })
    }
    return cells
  }

  if (style === 'horizontal') {
    const cellWidth = (innerWidth - g * (safeCount - 1)) / safeCount
    for (let i = 0; i < safeCount; i += 1) {
      cells.push({
        x: p + i * (cellWidth + g),
        y: p,
        width: cellWidth,
        height: innerHeight
      })
    }
    return cells
  }

  if (style === 'hero' && safeCount > 1) {
    const heroHeight = innerHeight * 0.64
    cells.push({
      x: p,
      y: p,
      width: innerWidth,
      height: heroHeight
    })
    const rest = safeCount - 1
    const columns = Math.min(rest, rest <= 3 ? rest : 4)
    const rows = Math.ceil(rest / columns)
    const startY = p + heroHeight + g
    const availableHeight = height - p - startY
    const cellWidth = (innerWidth - g * (columns - 1)) / columns
    const cellHeight = (availableHeight - g * (rows - 1)) / rows
    for (let i = 0; i < rest; i += 1) {
      const column = i % columns
      const row = Math.floor(i / columns)
      cells.push({
        x: p + column * (cellWidth + g),
        y: startY + row * (cellHeight + g),
        width: cellWidth,
        height: cellHeight
      })
    }
    return cells
  }

  const columns = safeCount === 1 ? 1 : safeCount <= 4 ? 2 : 3
  const rows = Math.ceil(safeCount / columns)
  const cellWidth = (innerWidth - g * (columns - 1)) / columns
  const cellHeight = (innerHeight - g * (rows - 1)) / rows
  for (let i = 0; i < safeCount; i += 1) {
    const column = i % columns
    const row = Math.floor(i / columns)
    cells.push({
      x: p + column * (cellWidth + g),
      y: p + row * (cellHeight + g),
      width: cellWidth,
      height: cellHeight
    })
  }
  return cells
}

function getGridRects(width, height, rows, columns, gap) {
  const gapSize = Number(gap) || 0
  const cellWidth = (width - gapSize * (columns - 1)) / columns
  const cellHeight = (height - gapSize * (rows - 1)) / rows
  const rects = []
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      rects.push({
        x: column * (cellWidth + gapSize),
        y: row * (cellHeight + gapSize),
        width: cellWidth,
        height: cellHeight
      })
    }
  }
  return rects
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return value + ' B'
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
  return (value / 1024 / 1024).toFixed(2) + ' MB'
}

module.exports = {
  centerCropRect,
  clamp,
  colorDistanceSq,
  createCutoutWorkspace,
  perceptualColorDistanceSq,
  estimateBorderColors,
  formatBytes,
  getCollageLayout,
  getGridRects,
  removeBackground
}
