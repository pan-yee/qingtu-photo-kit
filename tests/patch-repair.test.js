const patchRepair = require('../miniprogram/utils/patch-repair')
const harness = require('./harness')
const helpers = require('./helpers')

const assert = harness.assert
const test = harness.test
const makeImage = helpers.makeImage

function ringPoints(centerX, centerY, radius, valueAt) {
  const points = []
  for (let i = 0; i < 48; i += 1) {
    const angle = (Math.PI * 2 * i) / 48
    const x = Math.round(centerX + Math.cos(angle) * radius)
    const y = Math.round(centerY + Math.sin(angle) * radius)
    points.push({ x: x, y: y, r: valueAt(x, y) })
  }
  return points
}

test('拟合平面可从大坐标样本中恢复系数', function () {
  const points = ringPoints(880, 1120, 60, function value(x, y) {
    return 0.02 * x - 0.03 * y + 100
  })
  const plane = patchRepair.fitPlane(points, 'r')
  assert(plane, '样本足够时应返回平面')
  assert(Math.abs(plane[0] - 0.02) < 1e-6, 'x 方向斜率偏差过大')
  assert(Math.abs(plane[1] + 0.03) < 1e-6, 'y 方向斜率偏差过大')
  assert(Math.abs(plane[2] - 100) < 1e-3, '截距偏差过大')
})

test('样本不足或共线时退化为均值', function () {
  assert.strictEqual(patchRepair.fitPlane([], 'r'), null)
  assert.strictEqual(patchRepair.fitPlane(ringPoints(10, 10, 2, function () {
    return 1
  }).slice(0, 7), 'r'), null)

  const collinear = []
  for (let i = 0; i < 16; i += 1) {
    collinear.push({ x: i, y: i, r: i })
  }
  assert.strictEqual(patchRepair.fitPlane(collinear, 'r'), null)
})

test('环形采样取到周边均匀色', function () {
  const image = makeImage(32, 32, function paint() {
    return [10, 20, 30]
  })
  const ring = patchRepair.collectRingSamples(
    image.data,
    image.width,
    image.height,
    16,
    16,
    5
  )
  assert(ring.points.length > 0)
  assert.deepStrictEqual(ring.average, [10, 20, 30, 255])
})

test('环形采样在边缘处自动跳过越界点', function () {
  const image = makeImage(20, 20, function paint() {
    return [90, 90, 90]
  })
  const ring = patchRepair.collectRingSamples(
    image.data,
    image.width,
    image.height,
    0,
    0,
    20
  )
  assert(ring.points.length > 0)
  assert.deepStrictEqual(ring.average, [90, 90, 90, 255])
})

test('修复笔刷用周边底色覆盖污点', function () {
  const image = makeImage(40, 40, function paint(x, y) {
    const inMark = x >= 17 && x < 23 && y >= 17 && y < 23
    return inMark ? [20, 20, 20] : [200, 200, 200]
  })
  const patch = patchRepair.buildRepairPatch(
    image.data,
    image.width,
    image.height,
    20,
    20,
    8
  )
  assert(patch)

  const centerX = 20 - patch.left
  const centerY = 20 - patch.top
  const centerOffset = (centerY * patch.width + centerX) * 4
  assert(Math.abs(patch.data[centerOffset] - 200) <= 2, '中心应被恢复为底色')
  assert.strictEqual(patch.data[centerOffset + 3], 255, '不透明度应保留')
})

test('修复补丁不会把圆形角落写成透明', function () {
  const image = makeImage(40, 40, function paint() {
    return [128, 128, 128]
  })
  const patch = patchRepair.buildRepairPatch(
    image.data,
    image.width,
    image.height,
    20,
    20,
    6
  )
  assert(patch)

  for (let y = 0; y < patch.height; y += 1) {
    for (let x = 0; x < patch.width; x += 1) {
      const imageX = patch.left + x
      const imageY = patch.top + y
      const distance = Math.hypot(imageX - 20, imageY - 20)
      const offset = (y * patch.width + x) * 4
      assert.strictEqual(
        patch.data[offset + 3],
        255,
        '补丁内所有像素都应保持原不透明度'
      )
      if (distance > 6) {
        assert.strictEqual(
          patch.data[offset],
          128,
          '圆形范围外应保留原像素'
        )
      }
    }
  }
})

test('中心越界时返回 null', function () {
  const image = makeImage(10, 10, function paint() {
    return [0, 0, 0]
  })
  assert.strictEqual(
    patchRepair.buildRepairPatch(image.data, image.width, image.height, -1, 5, 4),
    null
  )
  assert.strictEqual(
    patchRepair.buildRepairPatch(image.data, image.width, image.height, 5, 20, 4),
    null
  )
})

test('通道值裁剪到 0..255', function () {
  assert.strictEqual(patchRepair.clampChannel(-30), 0)
  assert.strictEqual(patchRepair.clampChannel(300), 255)
  assert.strictEqual(patchRepair.clampChannel(12.6), 13)
})
