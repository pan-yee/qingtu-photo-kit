const { assert, test } = require('./harness')
const { makeImage } = require('./helpers')
const portrait = require('../miniprogram/utils/portrait-segmentation')

function tensor(mask) {
  return { activation_10: { type: 'float32', shape: [1, 1, 256, 256], data: mask.buffer } }
}

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
