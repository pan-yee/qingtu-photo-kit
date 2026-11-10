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

// 主体之外占比很小的前景块视为碎屑（发丝、衣物阴影残片）。
const REGION_KEEP_RATIO = 0.03
// 被主体包围的小透明孔回填，大千图面 0.25% 的孔保留（如发缝、手臂环抱的空隙）。
const HOLE_MAX_DIVISOR = 400
const HOLE_MIN_LIMIT = 24

// 纹理屏障：局部亮度标准差。白墙和白毛衣亮度几乎一致，纯颜色阈值分不开，
// 但墙面平滑、针织衫有织物纹理，纹理可以当泛洪的地形屏障。
const TEXTURE_STEP = 2
const TEXTURE_RADIUS = 3
const TEXTURE_SCALE = 8
const TEXTURE_BARRIER = 2.4
// 保护带扩散：把纹理强度向四周放宽一格。虚焦的袖口、衣褶本身纹理很淡，
// 不扩散就会留下一串低纹理的漏点，被泛洪咬成锯齿状边缘。
const TEXTURE_SPREAD = 1
// 边缘剥离：把紧贴已移除区域、且与邻居几乎同色的像素再吃一层，消掉轮廓白边。
const PEEL_DEPTH = 24
const PEEL_COLOR_RATIO = 2
const PEEL_GAP = 5
// 闭运算半径：补平轮廓上被纹理咬出的锯齿。
const CLOSE_RADIUS = 6
// 墙上的投影是背景色被等比压暗的柔和过渡：同色相、只降亮度。
// 单纯放大容差也能一并吃掉，代价是浅灰衣服会被吞；这里改成两条同时成立才算影子：
// 亮度比例落在区间内，且与已确认的背景邻居逐通道色差很小。
// 影子是渐变，衣服轮廓是一条硬边，所以硬边挡得住，渐变放得过去。
const SHADOW_MIN_RATIO = 0.66
// 上限放到与背景等亮：投影的边缘本身就是跟墙同色的过渡带，
// 拦在 0.94 会留下一条涂不掉的白边。
const SHADOW_MAX_RATIO = 1
const SHADOW_CHANNEL_SLACK = 0.1
const SHADOW_STEP = 8
const SHADOW_LEVEL_FLOOR = 96

/**
 * 亮度标准差图，按 TEXTURE_STEP 降采样后返回 { data, width, height }，
 * data 为 0..255（标准差 × TEXTURE_SCALE）。
 * 降采样按步长取样，周期小于步长的高频纹理会因取到同相像素而读数偏低；
 * 实拍照片里织物织纹通常在 3 像素以上，不受影响，纯 CPU 开销减一半。
 * 结果只与照片有关，同一张图反复抠图时可以复用。
 */
function buildTextureMap(data, width, height, target) {
  const halfWidth = Math.ceil(width / TEXTURE_STEP)
  const halfHeight = Math.ceil(height / TEXTURE_STEP)
  const count = halfWidth * halfHeight
  const texture =
    target instanceof Uint8Array && target.length === count
      ? target
      : new Uint8Array(count)
  const luma = new Float32Array(count)

  for (let y = 0; y < halfHeight; y += 1) {
    const row = Math.min(height - 1, y * TEXTURE_STEP) * width
    const halfRow = y * halfWidth
    for (let x = 0; x < halfWidth; x += 1) {
      const offset = (row + Math.min(width - 1, x * TEXTURE_STEP)) * 4
      luma[halfRow + x] =
        data[offset] * 0.299 +
        data[offset + 1] * 0.587 +
        data[offset + 2] * 0.114
    }
  }

  // 按列维护纵向窗口，再横向滑动。每个采样点只进出窗口一次，
  // 避免逐像素重复遍历 7×7 邻域；额外内存只随图像宽度增长。
  const columnSum = new Float64Array(halfWidth)
  const columnSq = new Float64Array(halfWidth)
  function updateRow(y, direction) {
    const row = y * halfWidth
    for (let x = 0; x < halfWidth; x += 1) {
      const value = luma[row + x]
      columnSum[x] += direction * value
      columnSq[x] += direction * value * value
    }
  }
  for (let y = 0; y < Math.min(halfHeight, TEXTURE_RADIUS); y += 1) {
    updateRow(y, 1)
  }
  for (let y = 0; y < halfHeight; y += 1) {
    if (y + TEXTURE_RADIUS < halfHeight) updateRow(y + TEXTURE_RADIUS, 1)
    if (y > TEXTURE_RADIUS) updateRow(y - TEXTURE_RADIUS - 1, -1)
    const y0 = Math.max(0, y - TEXTURE_RADIUS)
    const y1 = Math.min(halfHeight - 1, y + TEXTURE_RADIUS)
    const halfRow = y * halfWidth
    let sum = 0
    let sumSq = 0
    for (let x = 0; x < Math.min(halfWidth, TEXTURE_RADIUS); x += 1) {
      sum += columnSum[x]
      sumSq += columnSq[x]
    }
    for (let x = 0; x < halfWidth; x += 1) {
      if (x + TEXTURE_RADIUS < halfWidth) {
        sum += columnSum[x + TEXTURE_RADIUS]
        sumSq += columnSq[x + TEXTURE_RADIUS]
      }
      if (x > TEXTURE_RADIUS) {
        sum -= columnSum[x - TEXTURE_RADIUS - 1]
        sumSq -= columnSq[x - TEXTURE_RADIUS - 1]
      }
      const x0 = Math.max(0, x - TEXTURE_RADIUS)
      const x1 = Math.min(halfWidth - 1, x + TEXTURE_RADIUS)
      const total = (x1 - x0 + 1) * (y1 - y0 + 1)
      const mean = sum / total
      const deviation = Math.sqrt(Math.max(0, sumSq / total - mean * mean))
      texture[halfRow + x] = Math.min(
        255,
        Math.round(deviation * TEXTURE_SCALE)
      )
    }
  }

  if (TEXTURE_SPREAD > 0) {
    const spread = new Uint8Array(count)
    for (let y = 0; y < halfHeight; y += 1) {
      const row = y * halfWidth
      for (let x = 0; x < halfWidth; x += 1) {
        const x0 = Math.max(0, x - TEXTURE_SPREAD)
        const x1 = Math.min(halfWidth - 1, x + TEXTURE_SPREAD)
        let best = 0
        for (let xx = x0; xx <= x1; xx += 1) {
          if (texture[row + xx] > best) best = texture[row + xx]
        }
        spread[row + x] = best
      }
    }
    for (let x = 0; x < halfWidth; x += 1) {
      for (let y = 0; y < halfHeight; y += 1) {
        const y0 = Math.max(0, y - TEXTURE_SPREAD)
        const y1 = Math.min(halfHeight - 1, y + TEXTURE_SPREAD)
        let best = 0
        for (let yy = y0; yy <= y1; yy += 1) {
          const value = spread[yy * halfWidth + x]
          if (value > best) best = value
        }
        texture[y * halfWidth + x] = best
      }
    }
  }

  return { data: texture, width: halfWidth, height: halfHeight }
}

/**
 * 边缘像素自身纹理强度的中位数。背景本身就有纹理（砖墙、木纹）时
 * 屏障必须放行，否则整张图都清不掉。
 */
function estimateBorderTexture(textureMap) {
  if (!textureMap || !textureMap.data) return 0
  const values = []
  const maxX = textureMap.width - 1
  const maxY = textureMap.height - 1
  const strideX = Math.max(1, Math.floor(maxX / 60))
  const strideY = Math.max(1, Math.floor(maxY / 60))

  function read(x, y) {
    values.push(textureMap.data[y * textureMap.width + x])
  }

  for (let x = 0; x <= maxX; x += strideX) {
    read(x, 0)
    read(x, maxY)
  }
  for (let y = 0; y <= maxY; y += strideY) {
    read(0, y)
    read(maxX, y)
  }
  if (!values.length) return 0
  values.sort(function ascending(a, b) {
    return a - b
  })
  return values[Math.floor(values.length / 2)]
}

function resolveTextureMap(source, width, height, provided) {
  const halfWidth = Math.ceil(width / TEXTURE_STEP)
  const halfHeight = Math.ceil(height / TEXTURE_STEP)
  if (
    provided &&
    provided.data instanceof Uint8Array &&
    provided.width === halfWidth &&
    provided.height === halfHeight &&
    provided.data.length === halfWidth * halfHeight
  ) {
    return provided
  }
  return buildTextureMap(source, width, height)
}

/**
 * 边缘剥离：从已判定为背景的区域向外逐层推进，只有“与相邻背景像素几乎同色”的
 * 像素才会被吃掉。衣服和背景之间有颜色台阶，推进到这里就停，不会继续吃进主体。
 */
function peelBackground(
  source,
  isBackground,
  width,
  height,
  backgrounds,
  colorLimitSq,
  gapLimitSq,
  depthLimit,
  queue,
  depthMap
) {
  const pixelCount = width * height
  depthMap.fill(0)
  let tail = 0

  function matchesBackground(index) {
    const offset = index * 4
    const red = source[offset]
    const green = source[offset + 1]
    const blue = source[offset + 2]
    for (let i = 0; i < backgrounds.length; i += 1) {
      const candidate = backgrounds[i]
      const dr = red - candidate[0]
      const dg = green - candidate[1]
      const db = blue - candidate[2]
      if (dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11 <= colorLimitSq) {
        return true
      }
    }
    return false
  }

  function similarNeighbor(index) {
    const x = index % width
    const y = (index - x) / width
    const offset = index * 4
    const red = source[offset]
    const green = source[offset + 1]
    const blue = source[offset + 2]

    function neighborMatches(neighbor) {
      if (!isBackground[neighbor]) return false
      const other = neighbor * 4
      const dr = red - source[other]
      const dg = green - source[other + 1]
      const db = blue - source[other + 2]
      return dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11 <= gapLimitSq
    }

    if (x > 0 && neighborMatches(index - 1)) return true
    if (x + 1 < width && neighborMatches(index + 1)) return true
    if (y > 0 && neighborMatches(index - width)) return true
    if (y + 1 < height && neighborMatches(index + width)) return true
    return false
  }

  function seed(index, depth) {
    if (isBackground[index] || depthMap[index]) return
    depthMap[index] = depth
    queue[tail] = index
    tail += 1
  }

  function seedNeighbors(index, depth) {
    const x = index % width
    const y = (index - x) / width
    if (x > 0) seed(index - 1, depth)
    if (x + 1 < width) seed(index + 1, depth)
    if (y > 0) seed(index - width, depth)
    if (y + 1 < height) seed(index + width, depth)
  }

  for (let index = 0; index < pixelCount; index += 1) {
    if (isBackground[index]) continue
    if (similarNeighbor(index)) seed(index, 1)
  }

  let head = 0
  while (head < tail) {
    const index = queue[head]
    head += 1
    const depth = depthMap[index]
    if (!matchesBackground(index)) continue
    if (!similarNeighbor(index)) continue
    isBackground[index] = 1
    if (depth < depthLimit) seedNeighbors(index, depth + 1)
  }
}

/**
 * 形态学闭运算（先膨胀后腐蚀），把轮廓上被纹理咬出的锯齿补平。
 * scratchA / scratchB 由调用方复用，避免每次渲染都分配整图缓冲。
 */
function closeCutoutMask(isBackground, width, height, radius, scratchA, scratchB) {
  const pixelCount = width * height

  // 横向 + 纵向的“窗口内是否存在目标值”扫描，output 与 input 不能是同一块。
  function spread(input, want, output) {
    for (let y = 0; y < height; y += 1) {
      const row = y * width
      for (let x = 0; x < width; x += 1) {
        const x0 = Math.max(0, x - radius)
        const x1 = Math.min(width - 1, x + radius)
        let hit = 0
        for (let xx = x0; xx <= x1; xx += 1) {
          if (input[row + xx] === want) {
            hit = 1
            break
          }
        }
        scratchB[row + x] = hit
      }
    }
    for (let y = 0; y < height; y += 1) {
      const y0 = Math.max(0, y - radius)
      const y1 = Math.min(height - 1, y + radius)
      const row = y * width
      for (let x = 0; x < width; x += 1) {
        let hit = 0
        for (let yy = y0; yy <= y1; yy += 1) {
          if (scratchB[yy * width + x] === want) {
            hit = 1
            break
          }
        }
        output[row + x] = hit
      }
    }
  }

  // 前景写进 scratchA：闭运算作用在前景上。
  for (let i = 0; i < pixelCount; i += 1) {
    scratchA[i] = isBackground[i] ? 0 : 1
  }
  // 前景膨胀，结果直接写回 isBackground（原值已备份在 scratchA）。
  spread(scratchA, 1, isBackground)
  // 再对膨胀后的背景做一次膨胀，得到闭运算后的背景。
  for (let i = 0; i < pixelCount; i += 1) {
    scratchA[i] = isBackground[i] ? 0 : 1
  }
  spread(scratchA, 1, isBackground)
}

/**
 * 清理分割结果的空间噪声：
 * 1) 删除与主体不连通的碎块；
 * 2) 回填被主体包围的小透明孔。
 * 只读写 alpha，不碰颜色，原地修改 output。
 */
function cleanCutoutRegions(output, width, height) {
  const pixelCount = width * height
  const visited = new Uint8Array(pixelCount)
  const queue = new Int32Array(pixelCount)
  const blocks = []
  let top = 0
  let largest = 0

  for (let start = 0; start < pixelCount; start += 1) {
    if (visited[start] || output[start * 4 + 3] < 64) continue
    const blockStart = top
    queue[top] = start
    top += 1
    visited[start] = 1
    let head = blockStart
    while (head < top) {
      const index = queue[head]
      head += 1
      const x = index % width
      const y = (index - x) / width
      if (x > 0 && !visited[index - 1] && output[(index - 1) * 4 + 3] >= 64) {
        visited[index - 1] = 1
        queue[top] = index - 1
        top += 1
      }
      if (
        x + 1 < width &&
        !visited[index + 1] &&
        output[(index + 1) * 4 + 3] >= 64
      ) {
        visited[index + 1] = 1
        queue[top] = index + 1
        top += 1
      }
      if (
        y > 0 &&
        !visited[index - width] &&
        output[(index - width) * 4 + 3] >= 64
      ) {
        visited[index - width] = 1
        queue[top] = index - width
        top += 1
      }
      if (
        y + 1 < height &&
        !visited[index + width] &&
        output[(index + width) * 4 + 3] >= 64
      ) {
        visited[index + width] = 1
        queue[top] = index + width
        top += 1
      }
    }
    const area = top - blockStart
    if (area > largest) largest = area
    blocks.push(blockStart, top)
  }

  const minArea = Math.max(16, Math.floor(largest * REGION_KEEP_RATIO))
  for (let i = 0; i < blocks.length; i += 2) {
    if (blocks[i + 1] - blocks[i] >= minArea) continue
    for (let p = blocks[i]; p < blocks[i + 1]; p += 1) {
      output[queue[p] * 4 + 3] = 0
    }
  }

  visited.fill(0)
  const maxHole = Math.max(
    HOLE_MIN_LIMIT,
    Math.floor(pixelCount / HOLE_MAX_DIVISOR)
  )
  let holeTop = 0
  for (let start = 0; start < pixelCount; start += 1) {
    if (visited[start] || output[start * 4 + 3] >= 32) continue
    const holeStart = holeTop
    queue[holeTop] = start
    holeTop += 1
    visited[start] = 1
    let head = holeStart
    let touchesBorder = false
    while (head < holeTop) {
      const index = queue[head]
      head += 1
      const x = index % width
      const y = (index - x) / width
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        touchesBorder = true
      }
      if (x > 0 && !visited[index - 1] && output[(index - 1) * 4 + 3] < 32) {
        visited[index - 1] = 1
        queue[holeTop] = index - 1
        holeTop += 1
      }
      if (
        x + 1 < width &&
        !visited[index + 1] &&
        output[(index + 1) * 4 + 3] < 32
      ) {
        visited[index + 1] = 1
        queue[holeTop] = index + 1
        holeTop += 1
      }
      if (
        y > 0 &&
        !visited[index - width] &&
        output[(index - width) * 4 + 3] < 32
      ) {
        visited[index - width] = 1
        queue[holeTop] = index - width
        holeTop += 1
      }
      if (
        y + 1 < height &&
        !visited[index + width] &&
        output[(index + width) * 4 + 3] < 32
      ) {
        visited[index + width] = 1
        queue[holeTop] = index + width
        holeTop += 1
      }
    }
    if (touchesBorder || holeTop - holeStart > maxHole) continue
    for (let p = holeStart; p < holeTop; p += 1) {
      output[queue[p] * 4 + 3] = 255
    }
  }
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
    distance: new Uint16Array(pixelCount),
    peelDepth: new Uint8Array(pixelCount),
    closed: new Uint8Array(pixelCount),
    scratch: new Uint8Array(pixelCount)
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
    workspace.distance.length === pixelCount &&
    workspace.peelDepth instanceof Uint8Array &&
    workspace.peelDepth.length === pixelCount &&
    workspace.closed instanceof Uint8Array &&
    workspace.closed.length === pixelCount &&
    workspace.scratch instanceof Uint8Array &&
    workspace.scratch.length === pixelCount
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

  // 纹理屏障的阈值随背景自身的纹理强度自适应：纯色墙面用默认值，
  // 砖墙 / 木纹这类纹理背景自动放宽，退回纯颜色判断。
  let textureData = null
  let textureWidth = 0
  let barrierQuant = 0
  if (opts.barrier !== false) {
    const textureMap = resolveTextureMap(source, width, height, opts.texture)
    textureData = textureMap.data
    textureWidth = textureMap.width
    barrierQuant = Math.max(
      Math.round(TEXTURE_BARRIER * TEXTURE_SCALE),
      estimateBorderTexture(textureMap) + Math.round(1.5 * TEXTURE_SCALE)
    )
  }
  // 小图上按比例收缩，避免闭运算把整张小图铺平；
  // 剥离深度至少要够得着屏障在轮廓外留下的那一圈细边。
  const shortSide = Math.min(width, height)
  const peelDepth = clamp(Math.round(shortSide * 0.06), 6, PEEL_DEPTH)
  const closeRadius = clamp(Math.round(shortSide / 150), 0, CLOSE_RADIUS)
  // 容差越大能带走的投影越深：默认容差 36 时约为背景亮度的 0.65 倍。
  const shadowMinRatio = clamp(
    SHADOW_MIN_RATIO + (34 - tolerance) * 0.0035,
    0.5,
    0.74
  )

  // 上次渲染的 visited 标记必须清空，否则会把旧背景区域误判为已访问。
  visited.fill(0)

  function isTextured(index) {
    const x = index % width
    const y = (index - x) / width
    return textureData[(y >> 1) * textureWidth + (x >> 1)] > barrierQuant
  }

  function isSmoothStep(neighborIndex, red, green, blue) {
    if (!visited[neighborIndex]) {
      return false
    }
    const offset = neighborIndex * 4
    return (
      Math.abs(red - source[offset]) <= SHADOW_STEP &&
      Math.abs(green - source[offset + 1]) <= SHADOW_STEP &&
      Math.abs(blue - source[offset + 2]) <= SHADOW_STEP
    )
  }

  // 影子必须从已确认的背景里「渗」进来，而不是被当成一个新的色块直接接受。
  function hasSmoothBackgroundNeighbor(index, red, green, blue) {
    const x = index % width
    const y = (index - x) / width
    return (
      (x > 0 && isSmoothStep(index - 1, red, green, blue)) ||
      (x + 1 < width && isSmoothStep(index + 1, red, green, blue)) ||
      (y > 0 && isSmoothStep(index - width, red, green, blue)) ||
      (y + 1 < height && isSmoothStep(index + width, red, green, blue))
    )
  }

  function matchesShadow(red, green, blue) {
    const luminance = red * 0.3 + green * 0.59 + blue * 0.11
    for (let i = 0; i < backgrounds.length; i += 1) {
      const candidate = backgrounds[i]
      const level =
        candidate[0] * 0.3 + candidate[1] * 0.59 + candidate[2] * 0.11
      // 太暗的背景不做投影推断：比例判定在暗部几乎没有区分度。
      if (level < SHADOW_LEVEL_FLOOR) {
        continue
      }
      const ratio = luminance / level
      if (ratio < shadowMinRatio || ratio > SHADOW_MAX_RATIO) {
        continue
      }
      // 压暗后仍然逐通道贴合，才说明是同一种颜色被遮了一层光。
      if (
        Math.abs(red - candidate[0] * ratio) <=
          candidate[0] * SHADOW_CHANNEL_SLACK + 4 &&
        Math.abs(green - candidate[1] * ratio) <=
          candidate[1] * SHADOW_CHANNEL_SLACK + 4 &&
        Math.abs(blue - candidate[2] * ratio) <=
          candidate[2] * SHADOW_CHANNEL_SLACK + 4
      ) {
        return true
      }
    }
    return false
  }

  function isBackground(index, allowShadow) {
    const offset = index * 4
    if (source[offset + 3] < 24) {
      return true
    }
    const red = source[offset]
    const green = source[offset + 1]
    const blue = source[offset + 2]
    let colorMatched = false
    for (let i = 0; i < backgrounds.length; i += 1) {
      const candidate = backgrounds[i]
      const dr = red - candidate[0]
      const dg = green - candidate[1]
      const db = blue - candidate[2]
      if (dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11 <= thresholdSq) {
        colorMatched = true
        break
      }
    }
    // 颜色对得上也要过纹理屏障：与背景同色的针织主体只能靠纹理分辨。
    if (colorMatched && (!textureData || !isTextured(index))) {
      return true
    }
    // 剩下的可能是投影：颜色被等比压暗，而且是从已确认的背景里平滑渗过来的。
    // 这条通道不看纹理屏障：投影的渐变本身就有纹理读数，会被屏障挡回去。
    return (
      allowShadow &&
      hasSmoothBackgroundNeighbor(index, red, green, blue) &&
      matchesShadow(red, green, blue)
    )
  }

  function push(index, allowShadow) {
    if (
      index >= 0 &&
      index < pixelCount &&
      !visited[index] &&
      isBackground(index, allowShadow)
    ) {
      visited[index] = 1
      queue[tail] = index
      tail += 1
    }
  }

  // 边框像素本身不走投影判定：逆光照片里整条边都是影子，按比例放行会连人一起吃掉。
  for (let x = 0; x < width; x += 1) {
    push(x, false)
    push((height - 1) * width + x, false)
  }
  for (let y = 1; y < height - 1; y += 1) {
    push(y * width, false)
    push(y * width + width - 1, false)
  }

  while (head < tail) {
    const index = queue[head]
    head += 1
    const x = index % width
    const y = (index - x) / width

    if (x > 0) push(index - 1, true)
    if (x + 1 < width) push(index + 1, true)
    if (y > 0) push(index - width, true)
    if (y + 1 < height) push(index + width, true)
  }

  if (textureData) {
    // 纹理屏障会在主体轮廓外留下一圈背景细边，先沿同色区域吃掉；
    // 再补平被纹理咬出的锯齿。
    peelBackground(
      source,
      visited,
      width,
      height,
      backgrounds,
      thresholdSq * PEEL_COLOR_RATIO * PEEL_COLOR_RATIO,
      PEEL_GAP * PEEL_GAP * 3,
      peelDepth,
      queue,
      workspace.peelDepth
    )
  }
  if (closeRadius > 0) {
    closeCutoutMask(
      visited,
      width,
      height,
      closeRadius,
      workspace.closed,
      workspace.scratch
    )
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

  if (opts.cleanRegions !== false) {
    cleanCutoutRegions(output, width, height)
  }

  let removedPixels = 0
  for (let index = 0; index < pixelCount; index += 1) {
    if (visited[index]) removedPixels += 1
  }

  return {
    data: output,
    width: width,
    height: height,
    removedPixels: removedPixels,
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
  buildTextureMap,
  centerCropRect,
  clamp,
  cleanCutoutRegions,
  closeCutoutMask,
  colorDistanceSq,
  createCutoutWorkspace,
  estimateBorderColors,
  estimateBorderTexture,
  formatBytes,
  getCollageLayout,
  getGridRects,
  peelBackground,
  perceptualColorDistanceSq,
  removeBackground
}

