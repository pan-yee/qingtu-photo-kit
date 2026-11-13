const { assert, test } = require('./harness')
const { makeImage } = require('./helpers')
const portrait = require('../miniprogram/utils/portrait-segmentation')

function tensor(mask) {
  return { activation_10: { type: 'float32', shape: [1, 1, 256, 256], data: mask.buffer } }
}

test('高清边缘范围全档位保持纯背景透明、脸和衣服不透明，不复活背景', function () {
  const source = makeImage(7, 1, () => [120, 130, 140, 255])
  const probabilities = [0, .001, .1, .5, .9, .999, 1]
  const mask = { matting: true, width: 7, height: 1, data: new Float32Array(probabilities) }
  for (const tolerance of [12, 24, 36, 60, 82]) {
    const result = portrait.applyPortraitMask(source, mask, { tolerance, featherRadius: 3 })
    const alpha = probabilities.map((_, i) => result.data[i * 4 + 3])
    assert.strictEqual(alpha[0], 0)
    assert.strictEqual(alpha[6], 255)
    assert(alpha[1] <= 1, '低透明度背景不能变为整片半透明背景')
    assert(alpha[5] >= 254, '近乎不透明衣物不能变透')
    for (let i = 1; i < alpha.length; i++) assert(alpha[i] >= alpha[i - 1])
    assert.deepStrictEqual(Array.from(result.data.slice(24, 27)), [120, 130, 140])
  }
})

test('高清范围只连续调整边缘，默认保持原值，保留与清除方向正确', function () {
  const source = makeImage(3, 1, () => [90, 80, 70, 255])
  const mask = { matting: true, width: 3, height: 1, data: new Float32Array([.25, .5, .75]) }
  const values = tolerance => portrait.applyPortraitMask(source, mask, { tolerance }).data
  const keep = values(12), neutral = values(36), clean = values(82)
  for (let i = 3; i < 12; i += 4) assert(keep[i] > neutral[i] && neutral[i] > clean[i])
  assert.deepStrictEqual([neutral[3], neutral[7], neutral[11]], [64, 128, 191])
})

test('MODNet 默认设置不改变原始透明度，保留细发丝的连续层次', function () {
  const source = makeImage(4, 1, () => [90, 80, 70, 255])
  const mask = { matting: true, width: 4, height: 1, data: new Float32Array([0, .25, .75, 1]) }
  const result = portrait.applyPortraitMask(source, mask)
  assert.deepStrictEqual([3, 7, 11, 15].map(i => result.data[i]), [0, 64, 191, 255])
})

test('去残色只修正附近有可靠背景的半透明边缘，不改变不透明人脸或原图', function () {
  const source = makeImage(5, 1, x => x === 0 ? [255, 255, 255, 255] : [160, 170, 180, 255])
  const mask = { matting: true, width: 5, height: 1, data: new Float32Array([0, 1, .5, 1, 1]) }
  const original = Array.from(source.data)
  const clean = portrait.applyPortraitMask(source, mask, { edgeCleanup: true })
  assert(clean.data[8] < 160, '混入白底的半透明边缘应减少白色残留')
  assert.deepStrictEqual(Array.from(clean.data.slice(12, 16)), [160, 170, 180, 255])
  assert.strictEqual(clean.data[11], 128)
  assert.deepStrictEqual(Array.from(source.data), original)
  const untouched = portrait.applyPortraitMask(source, { ...mask, data: new Float32Array(5).fill(.5) }, { edgeCleanup: true })
  assert.strictEqual(untouched.data[8], 160, '没有可靠背景时不猜测颜色')
})

test('额外柔化使用空间过渡，不把半透明发丝做二值化', function () {
  const source = makeImage(5, 1, () => [90, 80, 70, 255])
  const mask = { matting: true, width: 5, height: 1, data: new Float32Array([0, 0, 1, 1, 1]) }
  const result = portrait.applyPortraitMask(source, mask, { featherRadius: 5 })
  assert(result.data[7] > 0 && result.data[7] < 128)
  assert(result.data[11] > 128 && result.data[11] < 255)
})

test('高清抠图直接保留连续透明度和原始颜色，不把发丝半透明值二值化', function () {
  const source = makeImage(4, 1, function () { return [90, 80, 70, 255] })
  const mask = { matting: true, width: 4, height: 1, data: new Float32Array([0, .25, .75, 1]) }
  const result = portrait.applyPortraitMask(source, mask, { featherRadius: 0 })
  assert.deepStrictEqual(Array.from(result.data), [90,80,70,0,90,80,70,64,90,80,70,191,90,80,70,255])
})

test('人像模型输入为 RGB NCHW 0..1，透明度不进入颜色通道', function () {
  const input = portrait.createInput(makeImage(1, 1, function () { return [255, 0, 128, 0] }))
  assert.strictEqual(input.length, 256 * 256 * 3)
  for (let i = 0; i < 256 * 256; i += 1) {
    assert.strictEqual(input[i], 1)
    assert.strictEqual(input[256 * 256 + i], 0)
    assert.strictEqual(input[2 * 256 * 256 + i], Math.fround(128 / 255))
  }
})

test('人像输出检查形状、长度和有限概率，并复制引擎缓冲', function () {
  const mask = new Float32Array(256 * 256).fill(0.75)
  const result = portrait.readMask(tensor(mask))
  mask[0] = 0
  assert.strictEqual(result[0], 0.75)
  assert.throws(function () { portrait.readMask({}) }, /格式/)
  assert.throws(function () { portrait.readMask(tensor(new Float32Array(2))) }, /尺寸/)
  mask[1] = NaN
  assert.throws(function () { portrait.readMask(tensor(mask)) }, /无效/)
})

test('概率遮罩保留原始 RGB 与透明度，容差和柔化可控', function () {
  const source = makeImage(256, 256, function () { return [231, 241, 251, 180] })
  const mask = new Float32Array(256 * 256)
  for (let y = 0; y < 256; y += 1) {
    for (let x = 0; x < 256; x += 1) mask[y * 256 + x] = x < 64 ? 0 : x < 128 ? 0.5 : 1
  }
  const output = new Uint8ClampedArray(source.data.length)
  const soft = portrait.applyPortraitMask(source, mask, { output: output, featherRadius: 3 })
  assert.strictEqual(soft.data, output)
  assert.deepStrictEqual(Array.from(output.slice(0, 4)), [231, 241, 251, 0])
  assert.strictEqual(output[(100 * 256 + 100) * 4 + 3], 90)
  assert.strictEqual(output[(100 * 256 + 200) * 4 + 3], 180)
  const strict = portrait.applyPortraitMask(source, mask, { tolerance: 60, featherRadius: 0 })
  assert.strictEqual(strict.data[(100 * 256 + 100) * 4 + 3], 0)
  assert.strictEqual(source.data[3], 180)
})

test('遮罩双线性放大不会混入相邻行，并保留边缘像素', function () {
  const image = makeImage(513, 701, function () { return [100, 120, 130] })
  const all = new Float32Array(256 * 256).fill(1)
  assert.strictEqual(portrait.applyPortraitMask(image, all).removedPixels, 0)
  all.fill(0)
  assert.strictEqual(portrait.applyPortraitMask(image, all).removedPixels, 513 * 701)
})

test('本机分割会话只加载一次，可重复推理，并在离开时销毁', async function () {
  const previous = global.wx
  let loads = 0
  let runs = 0
  let destroyed = 0
  const mask = new Float32Array(256 * 256).fill(1)
  global.wx = { createInferenceSession: function (options) {
    loads += 1
    assert.strictEqual(options.model, 'models/selfie-segmentation.onnx')
    return {
      onLoad: function (callback) { queueMicrotask(callback) },
      onError: function () {},
      run: async function (inputs) {
        runs += 1
        assert.deepStrictEqual(inputs.input_1.shape, [1, 3, 256, 256])
        return tensor(mask)
      },
      destroy: function () { destroyed += 1 }
    }
  } }
  const engine = portrait.createSegmenter()
  try {
    const image = makeImage(2, 2, function () { return [20, 30, 40] })
    await engine.segment(image)
    await engine.segment(image)
    assert.strictEqual(loads, 1)
    assert.strictEqual(runs, 2)
    engine.dispose()
    await assert.rejects(engine.segment(image), /取消/)
    assert.strictEqual(destroyed, 1)
  } finally { engine.dispose(); global.wx = previous }
})

test('不支持本机推理的设备返回可识别错误', async function () {
  const previous = global.wx
  global.wx = {}
  const engine = portrait.createSegmenter()
  try {
    await assert.rejects(engine.segment(makeImage(1, 1, function () { return [0, 0, 0] })), /不支持/)
  } finally { engine.dispose(); global.wx = previous }
})

test('没有识别到人像时返回明确错误，不输出空白证件照', function () {
  assert.throws(function () {
    portrait.readMask(tensor(new Float32Array(256 * 256)))
  }, { code: 'NO_PORTRAIT' })
})
