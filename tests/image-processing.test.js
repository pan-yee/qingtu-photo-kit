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