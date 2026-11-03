function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function colorDistanceSq(a, b) {
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  return dr * dr + dg * dg + db * db
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
 * 从四边开始泛洪，仅移除与边缘连通的背景区域。
 * imageData 可为 Canvas 的 ImageData 或含 data/width/height 的普通对象。
 */
function removeBackground(imageData, options) {
  const opts = options || {}
  const width = imageData.width
  const height = imageData.height
  const source = imageData.data
  const tolerance = clamp(Number(opts.tolerance) || 34, 5, 100)
  const backgrounds =
    opts.backgroundColors && opts.backgroundColors.length
      ? opts.backgroundColors
      : estimateBorderColors(source, width, height)

  if (!backgrounds.length) {
    return {
      data: new Uint8ClampedArray(source),
      width: width,
      height: height,
      removedPixels: 0,
      backgroundColors: []
    }
  }

  const pixelCount = width * height
  const visited = new Uint8Array(pixelCount)
  const queue = new Int32Array(pixelCount)
  const thresholdSq = tolerance * tolerance * 3
  let head = 0
  let tail = 0

  function isBackground(index) {
    const offset = index * 4
    if (source[offset + 3] < 24) {
      return true
    }
    const color = [source[offset], source[offset + 1], source[offset + 2]]
    for (let i = 0; i < backgrounds.length; i += 1) {
      if (colorDistanceSq(color, backgrounds[i]) <= thresholdSq) {
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

  const output = new Uint8ClampedArray(source)
  for (let index = 0; index < pixelCount; index += 1) {
    if (visited[index]) {
      output[index * 4 + 3] = 0
    }
  }

  // 对紧邻透明区且与背景色接近的像素做轻度边缘柔化。
  if (opts.feather !== false) {
    const featherLimitSq = (tolerance + 18) * (tolerance + 18) * 3
    const pending = []
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x
        if (visited[index]) continue
        const nearTransparent =
          visited[index - 1] ||
          visited[index + 1] ||
          visited[index - width] ||
          visited[index + width]
        if (!nearTransparent) continue
        const color = [
          source[index * 4],
          source[index * 4 + 1],
          source[index * 4 + 2]
        ]
        let closest = Infinity
        for (let i = 0; i < backgrounds.length; i += 1) {
          closest = Math.min(
            closest,
            colorDistanceSq(color, backgrounds[i])
          )
        }
        if (closest < featherLimitSq) {
          const ratio = Math.sqrt(closest / featherLimitSq)
          pending.push([index, Math.round(150 * ratio)])
        }
      }
    }
    pending.forEach(function soften(item) {
      output[item[0] * 4 + 3] = Math.min(
        output[item[0] * 4 + 3],
        item[1]
      )
    })
  }

  return {
    data: output,
    width: width,
    height: height,
    removedPixels: tail,
    backgroundColors: backgrounds
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
  estimateBorderColors,
  formatBytes,
  getCollageLayout,
  getGridRects,
  removeBackground
}

