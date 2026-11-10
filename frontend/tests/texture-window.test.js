const { assert, test } = require('./harness')
const { buildTextureMap } = require('../miniprogram/utils/image-processing')
const { makeImage } = require('./helpers')

// 保留直接扫描邻域的参考实现，验证滑动窗口的边界与像素输出。
function reference(image) {
  const width = Math.ceil(image.width / 2)
  const height = Math.ceil(image.height / 2)
  const luma = new Float32Array(width * height)
  const raw = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * 2 * image.width + x * 2) * 4
      luma[y * width + x] = image.data[i] * 0.299 +
        image.data[i + 1] * 0.587 + image.data[i + 2] * 0.114
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0
      let square = 0
      let count = 0
      for (let yy = Math.max(0, y - 3); yy <= Math.min(height - 1, y + 3); yy += 1) {
        for (let xx = Math.max(0, x - 3); xx <= Math.min(width - 1, x + 3); xx += 1) {
          const value = luma[yy * width + xx]
          sum += value
          square += value * value
          count += 1
        }
      }
      raw[y * width + x] = Math.min(255,
        Math.round(Math.sqrt(Math.max(0, square / count - (sum / count) ** 2)) * 8))
    }
  }
  return raw.map(function spread(value, i) {
    let best = value
    const x = i % width
    const y = Math.floor(i / width)
    for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy += 1) {
      for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx += 1) {
        best = Math.max(best, raw[yy * width + xx])
      }
    }
    return best
  })
}

test('滑动纹理窗口与直接扫描一致，覆盖窄图、奇数尺寸与缓冲复用', function () {
  for (const [width, height] of [[1, 1], [1, 23], [27, 1], [5, 7], [18, 20], [73, 91]]) {
    const image = makeImage(width, height, function (x, y) {
      return [110 + (x * 13 + y * 7) % 21, 120 + (x * 3 + y * 11) % 17,
        130 + (x * 7 + y * 5) % 19]
    })
    const target = new Uint8Array(Math.ceil(width / 2) * Math.ceil(height / 2)).fill(255)
    const result = buildTextureMap(image.data, width, height, target)
    assert.strictEqual(result.data, target)
    assert.deepStrictEqual(result.data, reference(image), width + '×' + height)
  }
})
