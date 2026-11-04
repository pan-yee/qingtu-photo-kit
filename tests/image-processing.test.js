const processing = require('../miniprogram/utils/image-processing')
const harness = require('./harness')
const helpers = require('./helpers')

const assert = harness.assert
const test = harness.test
const makeImage = helpers.makeImage

test('识别纯色背景的边缘色', function () {
  const image = makeImage(40, 40, function paint(x, y) {
    const inSubject = x >= 12 && x < 28 && y >= 8 && y < 32
    return inSubject ? [210, 35, 55] : [248, 248, 244]
  })
  const colors = processing.estimateBorderColors(
    image.data,
    image.width,
    image.height
  )
  assert(colors.length >= 1, '应识别出至少一个边缘背景色')
  assert(colors[0][0] > 230, '主背景色应接近白色')
})

test('只移除与边缘连通的背景', function () {
  const image = makeImage(40, 40, function paint(x, y) {
    const inSubject = x >= 12 && x < 28 && y >= 8 && y < 32
    return inSubject ? [210, 35, 55] : [248, 248, 244]
  })
  const result = processing.removeBackground(image, {
    tolerance: 18,
    backgroundColors: [[248, 248, 244]]
  })
  assert.strictEqual(result.data[3], 0, '左上背景应变为透明')
  assert.strictEqual(
    result.data[(20 * 40 + 20) * 4 + 3],
    255,
    '中间主体应保持不透明'
  )
  assert(result.removedPixels > 700, '应移除连通背景区域')
})

test('羽化半径为 0 时保留锐利边缘', function () {
  const image = makeImage(20, 20, function paint(x, y) {
    const inSubject = x >= 5 && x < 15 && y >= 5 && y < 15
    return inSubject ? [210, 210, 210] : [248, 248, 244]
  })
  const result = processing.removeBackground(image, {
    tolerance: 18,
    backgroundColors: [[248, 248, 244]],
    featherRadius: 0
  })
  const edgeAlpha = result.data[(10 * 20 + 5) * 4 + 3]
  assert.strictEqual(edgeAlpha, 255, '关闭羽化时边缘应保持不透明')
})

test('羽化半径大于 0 时边缘做半透明过渡', function () {
  const image = makeImage(20, 20, function paint(x, y) {
    const inSubject = x >= 5 && x < 15 && y >= 5 && y < 15
    return inSubject ? [210, 210, 210] : [248, 248, 244]
  })
  const result = processing.removeBackground(image, {
    tolerance: 18,
    backgroundColors: [[248, 248, 244]],
    featherRadius: 3
  })
  const edgeAlpha = result.data[(10 * 20 + 5) * 4 + 3]
  assert(edgeAlpha < 255, '开启羽化后边缘应被柔化')
  assert(edgeAlpha > 0, '主体边缘不应被整块移除')
})

test('feather: false 等价于关闭羽化', function () {
  const image = makeImage(20, 20, function paint(x, y) {
    const inSubject = x >= 5 && x < 15 && y >= 5 && y < 15
    return inSubject ? [210, 210, 210] : [248, 248, 244]
  })
  const result = processing.removeBackground(image, {
    tolerance: 18,
    backgroundColors: [[248, 248, 244]],
    feather: false
  })
  assert.strictEqual(result.data[(10 * 20 + 5) * 4 + 3], 255)
})

test('无可用背景色时原样返回', function () {
  const image = makeImage(8, 8, function paint() {
    return [0, 0, 0, 0]
  })
  const result = processing.removeBackground(image)
  assert.strictEqual(result.removedPixels, 0)
  assert.deepStrictEqual(Array.from(result.data), Array.from(image.data))
  assert.strictEqual(result.backgroundColors.length, 0)
})

test('非法输入不会抛错', function () {
  assert.deepStrictEqual(processing.estimateBorderColors(null, 10, 10), [])
  assert.deepStrictEqual(processing.estimateBorderColors([], 0, 0), [])
})

test('居中裁剪：宽图与高图', function () {
  const cropWide = processing.centerCropRect(1200, 800, 900, 1200)
  assert.strictEqual(cropWide.sw, 600)
  assert.strictEqual(cropWide.sh, 800)
  assert.strictEqual(cropWide.sx, 300)

  const cropTall = processing.centerCropRect(800, 1200, 1200, 900)
  assert.strictEqual(cropTall.sw, 800)
  assert.strictEqual(cropTall.sh, 600)
  assert.strictEqual(cropTall.sy, 300)
})

test('居中裁剪：比例一致时不裁剪', function () {
  const crop = processing.centerCropRect(1200, 900, 400, 300)
  assert.strictEqual(crop.sx, 0)
  assert.strictEqual(crop.sy, 0)
  assert.strictEqual(crop.sw, 1200)
  assert.strictEqual(crop.sh, 900)
})

test('九宫格矩形铺满画布', function () {
  const grid = processing.getGridRects(1200, 1200, 3, 3, 0)
  assert.strictEqual(grid.length, 9)
  assert.strictEqual(grid[0].width, 400)
  assert.strictEqual(grid[8].x, 800)
  assert.strictEqual(grid[8].y, 800)

  const gapped = processing.getGridRects(1210, 1210, 3, 3, 10)
  assert.strictEqual(gapped[0].width, (1210 - 10 * 2) / 3)
  assert.strictEqual(gapped[2].x + gapped[2].width, 1210)
  assert.strictEqual(gapped[8].y + gapped[8].height, 1210)
})

test('宫格布局返回与图片数量一致的单元格', function () {
  const collage = processing.getCollageLayout(
    'grid',
    5,
    1200,
    1200,
    12,
    8
  )
  assert.strictEqual(collage.length, 5)
  collage.forEach(function validate(cell) {
    assert(cell.width > 0)
    assert(cell.height > 0)
  })
})

test('裁剪与布局参数被限制在有效范围', function () {
  assert.strictEqual(processing.getCollageLayout('grid', 0, 600, 600, 0, 0).length, 1)
  assert.strictEqual(processing.getCollageLayout('grid', 20, 600, 600, 0, 0).length, 9)
  assert.strictEqual(processing.clamp(5, 1, 3), 3)
  assert.strictEqual(processing.clamp(-5, 1, 3), 1)
})

test('体积格式化覆盖各量级', function () {
  assert.strictEqual(processing.formatBytes(1536), '1.5 KB')
  assert.strictEqual(processing.formatBytes(0), '0 B')
  assert.strictEqual(processing.formatBytes(1023), '1023 B')
  assert.strictEqual(processing.formatBytes(1024), '1.0 KB')
  assert.strictEqual(processing.formatBytes(1024 * 1024), '1.00 MB')
  assert.strictEqual(processing.formatBytes(undefined), '0 B')
})

test('颜色距离对同类颜色更小', function () {
  const base = [200, 120, 80]
  const near = [205, 122, 78]
  const far = [20, 20, 20]
  assert(processing.colorDistanceSq(base, near) < processing.colorDistanceSq(base, far))
  assert(
    processing.perceptualColorDistanceSq(base, near) <
      processing.perceptualColorDistanceSq(base, far)
  )
  assert.strictEqual(processing.colorDistanceSq(base, base), 0)
})

function paintPortrait(x, y) {
  const inSubject = x >= 8 && x < 22 && y >= 6 && y < 24
  return inSubject ? [210, 35, 55] : [248, 248, 244]
}

test('工作区可跨次复用且不残留上次标记', function () {
  const first = makeImage(30, 30, paintPortrait)
  const second = makeImage(30, 30, function paint(x, y) {
    const inSubject = x >= 2 && x < 28 && y >= 2 && y < 28
    return inSubject ? [210, 35, 55] : [248, 248, 244]
  })
  const options = {
    tolerance: 18,
    backgroundColors: [[248, 248, 244]],
    workspace: processing.createCutoutWorkspace(30, 30)
  }

  const reusedFirst = processing.removeBackground(first, options)
  const reusedSecond = processing.removeBackground(second, options)
  const fresh = processing.removeBackground(second, {
    tolerance: 18,
    backgroundColors: [[248, 248, 244]]
  })

  assert(reusedFirst.removedPixels > 400, '首次应移除大片背景')
  assert.strictEqual(
    reusedSecond.data[(15 * 30 + 15) * 4 + 3],
    255,
    '复用工作区时主体不能被上次的访问标记误删'
  )
  assert.deepStrictEqual(
    Array.from(reusedSecond.data),
    Array.from(fresh.data),
    '复用工作区的结果应与全新分配一致'
  )
  assert.strictEqual(reusedSecond.workspace.width, 30)
})

test('传入输出缓冲时原地写入并返回同一引用', function () {
  const image = makeImage(20, 20, paintPortrait)
  const output = new Uint8ClampedArray(image.data.length)
  const result = processing.removeBackground(image, {
    tolerance: 18,
    backgroundColors: [[248, 248, 244]],
    output: output
  })
  assert.strictEqual(result.data, output, '应复用调用方提供的缓冲')
  assert.strictEqual(result.data[3], 0, '复用缓冲仍应正确移除背景')
  assert.strictEqual(
    result.data[(15 * 20 + 12) * 4 + 3],
    255,
    '复用缓冲仍应保留主体'
  )
})

test('输出缓冲长度不符时自动重新分配', function () {
  const image = makeImage(20, 20, paintPortrait)
  const tooSmall = new Uint8ClampedArray(16)
  const result = processing.removeBackground(image, {
    tolerance: 18,
    backgroundColors: [[248, 248, 244]],
    output: tooSmall
  })
  assert.notStrictEqual(result.data, tooSmall)
  assert.strictEqual(result.data.length, image.data.length)
  assert.strictEqual(result.data[3], 0)
})

test('工作区尺寸不符时自动重建', function () {
  const image = makeImage(20, 20, paintPortrait)
  const result = processing.removeBackground(image, {
    tolerance: 18,
    backgroundColors: [[248, 248, 244]],
    workspace: processing.createCutoutWorkspace(10, 10)
  })
  assert.strictEqual(result.workspace.width, 20)
  assert.strictEqual(result.workspace.height, 20)
  assert.strictEqual(result.data[3], 0)
  assert.strictEqual(result.data[(15 * 20 + 12) * 4 + 3], 255)
})

test('纹理图在纯色图像上接近 0', function () {
  const image = makeImage(32, 32, function paint() {
    return [240, 240, 240]
  })
  const texture = processing.buildTextureMap(
    image.data,
    image.width,
    image.height
  )
  assert.strictEqual(texture.width, 16, '按步长 2 降采样')
  assert.strictEqual(texture.height, 16)
  assert.strictEqual(texture.data.length, 256)
  const max = Math.max.apply(null, Array.from(texture.data))
  assert(max <= 1, '均匀色块不应有纹理读数，实际 ' + max)
})

test('纹理图能区分平滑与带纹理区域', function () {
  const image = makeImage(32, 32, function paint(x) {
    // 左半平滑、右半按 4 像素条带跳变的灰阶，亮度均值相同。
    // 条带宽度必须大于取样步长，否则降采样会把它当成纯色。
    if (x < 16) return [240, 240, 240]
    return Math.floor(x / 4) % 2 === 0
      ? [228, 228, 228]
      : [252, 252, 252]
  })
  const texture = processing.buildTextureMap(
    image.data,
    image.width,
    image.height
  )
  // 取样点离边界远一点：保护带会向平滑区扩散一格。
  assert(texture.data[8 * 16 + 2] <= 1, '平滑区纹理应接近 0')
  assert(texture.data[8 * 16 + 12] > 8, '跳变区纹理应明显大于 0')
})

test('纹理强度向四周扩散出一格保护带', function () {
  // 只有中间一条带纹理，其余纯色：扩散应把保护带向外放宽一格。
  const image = makeImage(64, 32, function paint(x) {
    if (x < 30 || x > 33) return [240, 240, 240]
    return Math.floor(x / 2) % 2 === 0 ? [228, 228, 228] : [252, 252, 252]
  })
  const texture = processing.buildTextureMap(
    image.data,
    image.width,
    image.height
  )
  const row = 8 * texture.width
  assert(texture.data[row + 13] > 0, '纹理块本身应在保护带内')
  assert(texture.data[row + 11] > 0, '保护带应向外扩散一格')
  assert.strictEqual(texture.data[row + 10], 0, '扩散半径只有一格')
})

test('边缘纹理中位数能识别带纹理的背景', function () {
  const flat = makeImage(32, 32, function paint() {
    return [240, 240, 240]
  })
  const striped = makeImage(32, 32, function paint(x) {
    return Math.floor(x / 4) % 2 === 0
      ? [210, 210, 210]
      : [250, 250, 250]
  })
  const flatTexture = processing.buildTextureMap(flat.data, 32, 32)
  const stripedTexture = processing.buildTextureMap(striped.data, 32, 32)
  assert(
    processing.estimateBorderTexture(flatTexture) < 4,
    '纯色背景的边缘纹理应很小'
  )
  assert(
    processing.estimateBorderTexture(stripedTexture) > 20,
    '条纹背景的边缘纹理应明显偏大'
  )
  assert.strictEqual(processing.estimateBorderTexture(null), 0)
})

test('闭运算能补平轮廓上的细缝', function () {
  const width = 22
  const height = 18
  const radius = 2
  const mask = new Uint8Array(width * height).fill(1)
  // 主体占中间一块，中间留一条 1 像素宽的目标缝。
  // 四周留出大于半径的空白，才能验证“远处背景不受影响”。
  for (let y = 4; y <= 13; y += 1) {
    for (let x = 5; x <= 16; x += 1) {
      mask[y * width + x] = 0
    }
  }
  const slitX = 10
  for (let y = 4; y <= 13; y += 1) {
    mask[y * width + slitX] = 1
  }
  processing.closeCutoutMask(
    mask,
    width,
    height,
    radius,
    new Uint8Array(width * height),
    new Uint8Array(width * height)
  )
  assert.strictEqual(mask[9 * width + slitX], 0, '细缝应被闭运算填平')
  assert.strictEqual(mask[0], 1, '远离主体的背景不受影响')
  assert.strictEqual(
    mask[1 * width + 10],
    1,
    '距主体超过半径的背景不受影响'
  )
  assert.strictEqual(mask[9 * width + 6], 0, '主体内部保持前景')
})

test('剥离沿同色渐变推进并在明显色差处停下', function () {
  const width = 10
  const height = 1
  const data = new Uint8ClampedArray(width * 4)
  const colors = [
    [240, 240, 240],
    [240, 240, 240],
    [238, 238, 238],
    [236, 236, 236],
    [232, 232, 232],
    [100, 100, 100],
    [100, 100, 100],
    [100, 100, 100],
    [100, 100, 100],
    [100, 100, 100]
  ]
  for (let i = 0; i < width; i += 1) {
    data[i * 4] = colors[i][0]
    data[i * 4 + 1] = colors[i][1]
    data[i * 4 + 2] = colors[i][2]
    data[i * 4 + 3] = 255
  }
  const mask = new Uint8Array(width)
  mask[0] = 1
  mask[1] = 1
  processing.peelBackground(
    data,
    mask,
    width,
    height,
    [[240, 240, 240]],
    18 * 18 * 3,
    5 * 5 * 3,
    24,
    new Int32Array(width),
    new Uint8Array(width)
  )
  assert.strictEqual(mask[1], 1, '原有背景保持')
  assert.strictEqual(mask[2], 1, '紧贴的同色像素应被吃掉')
  assert.strictEqual(mask[4], 1, '渐变末端仍在颜色许可范围内但色差逐步累加')
  assert.strictEqual(mask[5], 0, '遇到明显色差的色块就停')
})

test('剥离受深度上限约束', function () {
  const width = 8
  const height = 1
  const data = new Uint8ClampedArray(width * 4).fill(240)
  const mask = new Uint8Array(width)
  mask[0] = 1
  processing.peelBackground(
    data,
    mask,
    width,
    height,
    [[240, 240, 240]],
    18 * 18 * 3,
    5 * 5 * 3,
    2,
    new Int32Array(width),
    new Uint8Array(width)
  )
  assert.strictEqual(mask[2], 1, '两层内应被吃掉')
  assert.strictEqual(mask[3], 0, '超过深度上限不再推进')
})

test('碎块清理删除孤立小块并回填小孔', function () {
  const width = 40
  const height = 40
  const output = new Uint8ClampedArray(width * height * 4)
  function setAlpha(x, y, alpha) {
    output[(y * width + x) * 4 + 3] = alpha
  }
  for (let y = 5; y <= 24; y += 1) {
    for (let x = 5; x <= 24; x += 1) {
      setAlpha(x, y, 255)
    }
  }
  // 孤立碎块
  for (let y = 32; y <= 33; y += 1) {
    for (let x = 32; x <= 33; x += 1) {
      setAlpha(x, y, 255)
    }
  }
  // 主体内的小孔与大孔
  for (let y = 12; y <= 13; y += 1) {
    for (let x = 12; x <= 13; x += 1) {
      setAlpha(x, y, 0)
    }
  }
  for (let y = 18; y <= 23; y += 1) {
    for (let x = 18; x <= 23; x += 1) {
      setAlpha(x, y, 0)
    }
  }

  processing.cleanCutoutRegions(output, width, height)

  assert.strictEqual(
    output[(32 * width + 32) * 4 + 3],
    0,
    '与主体不连通的碎块应被删除'
  )
  assert.strictEqual(
    output[(12 * width + 12) * 4 + 3],
    255,
    '被主体包围的小孔应被回填'
  )
  assert.strictEqual(
    output[(20 * width + 20) * 4 + 3],
    0,
    '过大的孔保留，避免吞掉真实镂空'
  )
  assert.strictEqual(output[3], 0, '与边界连通的透明区不受影响')
})

test('纹理屏障保住与背景同色的针织主体', function () {
  const image = makeImage(40, 40, function paint(x, y) {
    const inSubject = x >= 10 && x < 30 && y >= 10 && y < 30
    if (!inSubject) return [242, 242, 242]
    // 主体与背景平均颜色几乎一致，只有织物纹理不同
    return (x + y) % 2 === 0 ? [236, 236, 236] : [248, 248, 248]
  })
  const result = processing.removeBackground(image, {
    tolerance: 18,
    backgroundColors: [[242, 242, 242]]
  })
  assert.strictEqual(result.data[3], 0, '背景仍应被移除')
  assert.strictEqual(
    result.data[(20 * 40 + 20) * 4 + 3],
    255,
    '与背景同色的纹理主体应被保住'
  )
})

test('关闭屏障时同色主体会被整体移除', function () {
  const image = makeImage(40, 40, function paint(x, y) {
    const inSubject = x >= 10 && x < 30 && y >= 10 && y < 30
    if (!inSubject) return [242, 242, 242]
    return (x + y) % 2 === 0 ? [236, 236, 236] : [248, 248, 248]
  })
  const result = processing.removeBackground(image, {
    tolerance: 18,
    backgroundColors: [[242, 242, 242]],
    barrier: false
  })
  assert.strictEqual(
    result.data[(20 * 40 + 20) * 4 + 3],
    0,
    '关闭屏障后结果应与纯颜色判断一致'
  )
})

test('传入缓存纹理图与内部计算的结果一致', function () {
  const image = makeImage(40, 40, function paint(x, y) {
    const inSubject = x >= 10 && x < 30 && y >= 10 && y < 30
    if (!inSubject) return [242, 242, 242]
    return (x + y) % 2 === 0 ? [236, 236, 236] : [248, 248, 248]
  })
  const texture = processing.buildTextureMap(
    image.data,
    image.width,
    image.height
  )
  const cached = processing.removeBackground(image, {
    tolerance: 18,
    backgroundColors: [[242, 242, 242]],
    texture: texture
  })
  const inline = processing.removeBackground(image, {
    tolerance: 18,
    backgroundColors: [[242, 242, 242]]
  })
  assert.deepStrictEqual(
    Array.from(cached.data),
    Array.from(inline.data),
    '复用纹理图不应改变结果'
  )
  const mismatched = processing.removeBackground(image, {
    tolerance: 18,
    backgroundColors: [[242, 242, 242]],
    texture: { data: new Uint8Array(4), width: 2, height: 2 }
  })
  assert.deepStrictEqual(
    Array.from(mismatched.data),
    Array.from(inline.data),
    '尺寸不符的纹理图应被丢弃并重新计算'
  )
})

// 墙上的投影：同色相、只降亮度，而且是从墙面渐变过来的。
const SHADOW_WALL = [246, 244, 238]

function paintWallOrShadow(x) {
  if (x < 40) return SHADOW_WALL
  const t = Math.min(1, (x - 40) / 10)
  const ratio = 1 - 0.32 * t
  return [
    SHADOW_WALL[0] * ratio,
    SHADOW_WALL[1] * ratio,
    SHADOW_WALL[2] * ratio
  ]
}

function shadowPhoto() {
  return makeImage(60, 60, function paint(x, y) {
    const inSubject = x >= 20 && x < 34 && y >= 10 && y < 50
    if (inSubject) return [206, 44, 60]
    return paintWallOrShadow(x)
  })
}

function alphaReader(image, result) {
  return function alphaAt(x, y) {
    return result.data[(y * image.width + x) * 4 + 3]
  }
}

test('墙面上的柔和投影随背景一起移除', function () {
  const image = shadowPhoto()
  const result = processing.removeBackground(image, {
    tolerance: 36,
    backgroundColors: [SHADOW_WALL]
  })
  const alphaAt = alphaReader(image, result)
  assert.strictEqual(alphaAt(8, 5), 0, '正常墙面应移除')
  assert.strictEqual(alphaAt(42, 5), 0, '投影的渐变前端应移除')
  assert.strictEqual(alphaAt(55, 5), 0, '压暗到 0.68 的投影深处也应移除')
  assert.strictEqual(alphaAt(27, 30), 255, '主体不受影响')
})

test('容差决定能带走多深的投影', function () {
  const image = shadowPhoto()
  const gentle = processing.removeBackground(image, {
    tolerance: 12,
    backgroundColors: [SHADOW_WALL]
  })
  const strong = processing.removeBackground(image, {
    tolerance: 82,
    backgroundColors: [SHADOW_WALL]
  })
  assert.strictEqual(
    alphaReader(image, gentle)(55, 5),
    255,
    '低容差时较深的投影保留'
  )
  assert.strictEqual(
    alphaReader(image, strong)(55, 5),
    0,
    '高容差把投影一起去掉'
  )
  assert.strictEqual(alphaReader(image, strong)(27, 30), 255, '主体始终保留')
})

test('硬边的浅灰衣物不会被当成投影', function () {
  // 亮度比例落在投影区间内，但边界是一条硬边，不是渐变。
  const image = makeImage(60, 60, function paint(x, y) {
    const inCloth = x >= 15 && x < 45 && y >= 15 && y < 55
    if (!inCloth) return SHADOW_WALL
    return [
      SHADOW_WALL[0] * 0.72,
      SHADOW_WALL[1] * 0.72,
      SHADOW_WALL[2] * 0.72
    ]
  })
  const result = processing.removeBackground(image, {
    tolerance: 36,
    backgroundColors: [SHADOW_WALL]
  })
  const alphaAt = alphaReader(image, result)
  assert.strictEqual(alphaAt(30, 30), 255, '硬边挡住投影通道')
  assert.strictEqual(alphaAt(5, 5), 0, '墙面仍然移除')
})

test('带织纹的衣物不会被当成投影', function () {
  const image = makeImage(60, 60, function paint(x, y) {
    const inCloth = x >= 15 && x < 45 && y >= 15 && y < 55
    if (!inCloth) return SHADOW_WALL
    const tone = SHADOW_WALL[0] * 0.88 + ((x % 4) - 1.5) * 4
    return [tone, tone * 0.99, tone * 0.97]
  })
  const result = processing.removeBackground(image, {
    tolerance: 36,
    backgroundColors: [SHADOW_WALL]
  })
  const alphaAt = alphaReader(image, result)
  assert.strictEqual(alphaAt(30, 30), 255, '织纹的逐像素起伏超过渐变步长')
  assert.strictEqual(alphaAt(40, 40), 255)
  assert.strictEqual(alphaAt(5, 5), 0, '墙面仍然移除')
})
