const { assert, test } = require('./harness')
const framing = require('../miniprogram/utils/portrait-framing')

test('完整照片仅等比缩小，宽幅照片不提前裁掉主体', function () {
  assert.deepStrictEqual(framing.fitSize(3200, 1800, 1600), { width: 1600, height: 900 })
  assert.deepStrictEqual(framing.fitSize(300, 500, 1600), { width: 300, height: 500 })
})

test('偏左人脸会对齐到照片中央，头顶留白且包含发顶', function () {
  const mask = { matting: true, width: 100, height: 100, data: new Float32Array(10000) }
  for (let y = 10; y < 100; y += 1) {
    for (let x = 5; x < 40; x += 1) mask.data[y * 100 + x] = 1
  }
  const face = { x: .1, y: .2, width: .2, height: .2 }
  const crop = framing.portraitCrop(1000, 1000, face, mask, 900, 1200)
  assert.strictEqual(crop.faceAligned, true)
  assert(Math.abs(crop.sx + crop.sw / 2 - 200) < 1e-6)
  const headTop = (100 - crop.sy) / crop.sh
  assert(headTop > .05 && headTop < .13)
  assert(Math.abs(crop.sw / crop.sh - .75) < 1e-6)
})

test('构图允许图外透明留白，遮罩同步裁切且不复制边缘人物', function () {
  const mask = { matting: true, width: 2, height: 2, data: new Float32Array(4).fill(1) }
  const result = framing.cropMask(mask, { sx: -50, sy: 0, sw: 100, sh: 100 }, 100, 100)
  assert.strictEqual(result.data[0], 0)
  assert.strictEqual(result.data[449], 1)
  assert.strictEqual(result.matting, true)
})

test('没有人脸或异常坐标时不猜测人脸位置，返回可识别的居中构图', function () {
  assert.strictEqual(framing.validFace({ x: NaN, y: 0, width: .2, height: .2 }), false)
  assert.strictEqual(framing.validFace({ x: .9, y: 0, width: .2, height: .2 }), false)
  const crop = framing.portraitCrop(1000, 500, null, null, 900, 1200)
  assert.strictEqual(crop.faceAligned, false)
  assert.strictEqual(crop.sy, 0)
  assert.strictEqual(crop.sh, 500)
})

test('局部推理的遮罩按原图坐标还原，不把局部人像拉满整张照片', function () {
  const mask = { matting: true, width: 4, height: 4, data: new Float32Array(16).fill(1),
    region: { x: .25, y: .25, width: .5, height: .5 } }
  const result = framing.cropMask(mask, { sx: 0, sy: 0, sw: 100, sh: 100 }, 100, 100)
  assert.strictEqual(result.data[0], 0)
  assert.strictEqual(result.data[300 * 450 + 225], 1)
  assert.strictEqual(result.data[599 * 450 + 449], 0)
})
