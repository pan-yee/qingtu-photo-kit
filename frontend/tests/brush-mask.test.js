const masks = require('../miniprogram/utils/brush-mask')
const processing = require('../miniprogram/utils/image-processing')
const harness = require('./harness')
const helpers = require('./helpers')

const assert = harness.assert
const test = harness.test
const makeImage = helpers.makeImage

function alphaAt(image, x, y) {
  return image.data[(y * image.width + x) * 4 + 3]
}

test('新建遮罩全为不干预', function () {
  const mask = masks.createMask(12, 8)
  assert.strictEqual(mask.length, 96)
  assert.strictEqual(masks.countPainted(mask), 0)
  assert.strictEqual(masks.createMask(0, 8).length, 0, '尺寸非法时返回空遮罩')
})

test('圆形涂抹只覆盖半径内的像素', function () {
  const width = 20
  const height = 20
  const mask = masks.createMask(width, height)
  const changed = masks.paintCircle(mask, width, height, 10, 10, 3, masks.MASK_ERASE)
  assert.strictEqual(mask[10 * width + 10], masks.MASK_ERASE, '圆心应被涂到')
  assert.strictEqual(mask[10 * width + 12], masks.MASK_ERASE, '半径内应被涂到')
  assert.strictEqual(mask[10 * width + 14], 0, '半径外不应被涂到')
  assert.strictEqual(changed, masks.countPainted(mask), '返回值应与实际改动一致')
  assert(changed > 20, '半径 3 的圆应覆盖几十个像素，实际 ' + changed)
})

test('重复涂抹同一片区域不重复计数', function () {
  const mask = masks.createMask(20, 20)
  const first = masks.paintCircle(mask, 20, 20, 10, 10, 3, masks.MASK_ERASE)
  const second = masks.paintCircle(mask, 20, 20, 10, 10, 3, masks.MASK_ERASE)
  assert(first > 0, '首次涂抹应有改动')
  assert.strictEqual(second, 0, '相同位置重复涂抹不应改动')
})

test('涂抹可以覆盖成另一种标记', function () {
  const mask = masks.createMask(20, 20)
  masks.paintCircle(mask, 20, 20, 10, 10, 3, masks.MASK_ERASE)
  const changed = masks.paintCircle(mask, 20, 20, 10, 10, 2, masks.MASK_KEEP)
  assert(changed > 0, '换成保留标记应产生改动')
  assert.strictEqual(mask[10 * 20 + 10], masks.MASK_KEEP)
})

test('涂抹落在画布外不越界', function () {
  const mask = masks.createMask(10, 10)
  const changed = masks.paintCircle(mask, 10, 10, -5, -5, 4, masks.MASK_KEEP)
  assert(changed >= 0, '越界涂抹不应抛错')
  assert.strictEqual(mask.length, 100)
  assert.strictEqual(masks.countPainted(mask), changed)
})

test('遮罩叠加只改 alpha：保留补回不透明、擦除置透明', function () {
  const image = makeImage(6, 6, function paint(x) {
    return x < 3 ? [200, 60, 60, 0] : [200, 60, 60, 255]
  })
  const mask = masks.createMask(6, 6)
  masks.paintCircle(mask, 6, 6, 1, 3, 1, masks.MASK_KEEP)
  masks.paintCircle(mask, 6, 6, 4, 3, 1, masks.MASK_ERASE)

  const applied = masks.applyMask(image, mask)
  assert.strictEqual(alphaAt(image, 1, 3), 255, '被标记保留的像素应恢复不透明')
  assert.strictEqual(alphaAt(image, 4, 3), 0, '被标记擦除的像素应变为透明')
  assert.strictEqual(
    image.data[(3 * 6 + 1) * 4],
    200,
    '叠加遮罩不应改动颜色通道'
  )
  assert.strictEqual(applied, masks.countPainted(mask), '改动数应等于涂抹像素数')
})

test('遮罩比图像短时只看重叠部分', function () {
  const image = makeImage(4, 4, function paint() {
    return [10, 10, 10, 255]
  })
  const mask = new Uint8Array(4).fill(masks.MASK_ERASE)
  const applied = masks.applyMask(image, mask)
  assert.strictEqual(applied, 4, '只处理遮罩覆盖的前 4 个像素')
  assert.strictEqual(image.data[3], 0, '第一个像素被擦除')
  assert.strictEqual(image.data[(3 * 4 + 3) * 4 + 3], 255, '其余像素不受影响')
})

test('清空遮罩后不再干预结果', function () {
  const mask = masks.createMask(8, 8)
  masks.paintCircle(mask, 8, 8, 4, 4, 3, masks.MASK_KEEP)
  masks.clearMask(mask)
  assert.strictEqual(masks.countPainted(mask), 0)
  const image = makeImage(8, 8, function paint() {
    return [10, 10, 10, 0]
  })
  assert.strictEqual(masks.applyMask(image, mask), 0)
})

test('触控点按屏幕密度换算到照片像素', function () {
  // 375 CSS 宽、2 倍屏、照片 900 宽：缓冲区 750 像素，scale = 750 / 900
  const scale = 750 / 900
  const center = masks.toPhotoPoint(187.5, 250, 2, scale)
  assert.strictEqual(center.x, 450, '横向中心应对应照片的一半，实际 ' + center.x)
  assert.strictEqual(center.y, 600, '纵向中心应对应照片的一半，实际 ' + center.y)
  const corner = masks.toPhotoPoint(375, 500, 2, scale)
  assert.strictEqual(corner.x, 900, '右下角应对应照片宽高')
  assert.strictEqual(corner.y, 1200)
  assert.strictEqual(
    masks.toPhotoPoint(10, 10, 0, scale),
    null,
    '缩放参数无效时返回 null'
  )
})

test('手动保留能把被自动删掉的主体补回来', function () {
  const width = 40
  const height = 40
  const image = makeImage(width, height, function paint(x, y) {
    const inSubject = x >= 10 && x < 30 && y >= 10 && y < 30
    return inSubject ? [250, 250, 250] : [250, 250, 250]
  })
  // 主体与背景同色，纯颜色判断会整块移除——正是需要手动补回的场景。
  const result = processing.removeBackground(image, {
    tolerance: 18,
    backgroundColors: [[250, 250, 250]],
    barrier: false,
    cleanRegions: false
  })
  assert.strictEqual(alphaAt(result, 20, 20), 0, '自动结果应把同色主体一起删掉')

  const mask = masks.createMask(width, height)
  masks.paintCircle(mask, width, height, 20, 20, 6, masks.MASK_KEEP)
  masks.applyMask(result, mask)
  assert.strictEqual(alphaAt(result, 20, 20), 255, '涂抹处应恢复为不透明')
  assert.strictEqual(alphaAt(result, 2, 2), 0, '未涂抹的背景保持透明')
})

test('手动擦除能清掉自动漏掉的残留', function () {
  const width = 40
  const height = 40
  const image = makeImage(width, height, function paint(x, y) {
    const inSubject = x >= 12 && x < 28 && y >= 8 && y < 32
    return inSubject ? [210, 35, 55] : [248, 248, 244]
  })
  const result = processing.removeBackground(image, {
    tolerance: 18,
    backgroundColors: [[248, 248, 244]],
    cleanRegions: false
  })
  assert.strictEqual(alphaAt(result, 20, 20), 255, '主体应保留')

  const mask = masks.createMask(width, height)
  masks.paintCircle(mask, width, height, 20, 20, 4, masks.MASK_ERASE)
  masks.applyMask(result, mask)
  assert.strictEqual(alphaAt(result, 20, 20), 0, '涂抹处应变为透明')
  assert.strictEqual(alphaAt(result, 13, 20), 255, '未涂抹的主体保持不透明')
})
