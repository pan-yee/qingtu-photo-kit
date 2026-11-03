const assert = require('assert')
const processing = require('../miniprogram/utils/image-processing')

function makeImage(width, height, painter) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = painter(x, y)
      const offset = (y * width + x) * 4
      data[offset] = color[0]
      data[offset + 1] = color[1]
      data[offset + 2] = color[2]
      data[offset + 3] = color[3] === undefined ? 255 : color[3]
    }
  }
  return { data: data, width: width, height: height }
}

function tests() {
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

  const cropWide = processing.centerCropRect(1200, 800, 900, 1200)
  assert.strictEqual(cropWide.sw, 600)
  assert.strictEqual(cropWide.sh, 800)
  assert.strictEqual(cropWide.sx, 300)

  const cropTall = processing.centerCropRect(800, 1200, 1200, 900)
  assert.strictEqual(cropTall.sw, 800)
  assert.strictEqual(cropTall.sh, 600)
  assert.strictEqual(cropTall.sy, 300)

  const grid = processing.getGridRects(1200, 1200, 3, 3, 0)
  assert.strictEqual(grid.length, 9)
  assert.strictEqual(grid[0].width, 400)
  assert.strictEqual(grid[8].x, 800)
  assert.strictEqual(grid[8].y, 800)

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
  assert.strictEqual(processing.formatBytes(1536), '1.5 KB')
}

tests()
console.log('All image processing tests passed.')

