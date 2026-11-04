const processing = require('../miniprogram/utils/image-processing')
const harness = require('./harness')

const assert = harness.assert
const test = harness.test

const STYLES = ['grid', 'hero', 'vertical', 'horizontal']
const COUNTS = [1, 2, 3, 4, 5, 6, 9]
const WIDTH = 1200
const HEIGHT = 1600
const PADDING = 20
const GAP = 10

function overlaps(a, b) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (width <= 0 || height <= 0) return 0
  return width * height
}

STYLES.forEach(function styleSuite(style) {
  COUNTS.forEach(function countSuite(count) {
    test(style + ' 版式在 ' + count + ' 张图片时铺满画布且互不重叠', function () {
      const cells = processing.getCollageLayout(
        style,
        count,
        WIDTH,
        HEIGHT,
        PADDING,
        GAP
      )
      assert.strictEqual(cells.length, count)
      const epsilon = 1e-6
      cells.forEach(function validate(cell) {
        assert(cell.width > 0, '单元格宽度必须为正')
        assert(cell.height > 0, '单元格高度必须为正')
        assert(cell.x >= PADDING - epsilon, '超出左边界')
        assert(cell.y >= PADDING - epsilon, '超出上边界')
        assert(cell.x + cell.width <= WIDTH - PADDING + epsilon, '超出右边界')
        assert(
          cell.y + cell.height <= HEIGHT - PADDING + epsilon,
          '超出下边界'
        )
      })
      for (let i = 0; i < cells.length; i += 1) {
        for (let j = i + 1; j < cells.length; j += 1) {
          assert.strictEqual(
            overlaps(cells[i], cells[j]),
            0,
            '单元格 ' + i + ' 与 ' + j + ' 重叠'
          )
        }
      }
    })
  })
})

test('海报版式的首图占满整行', function () {
  const cells = processing.getCollageLayout('hero', 5, WIDTH, HEIGHT, PADDING, GAP)
  assert.strictEqual(cells[0].x, PADDING)
  assert.strictEqual(cells[0].width, WIDTH - PADDING * 2)
  assert.strictEqual(cells.length, 5)
})

test('竖版与横版的单元格尺寸一致', function () {
  const vertical = processing.getCollageLayout(
    'vertical',
    4,
    WIDTH,
    HEIGHT,
    PADDING,
    GAP
  )
  vertical.forEach(function sameWidth(cell) {
    assert.strictEqual(cell.width, vertical[0].width)
    assert.strictEqual(cell.x, PADDING)
  })

  const horizontal = processing.getCollageLayout(
    'horizontal',
    4,
    WIDTH,
    HEIGHT,
    PADDING,
    GAP
  )
  horizontal.forEach(function sameHeight(cell) {
    assert.strictEqual(cell.height, horizontal[0].height)
    assert.strictEqual(cell.y, PADDING)
  })
})

test('未知版式回退到宫格排列', function () {
  const fallback = processing.getCollageLayout(
    'unknown',
    4,
    WIDTH,
    HEIGHT,
    PADDING,
    GAP
  )
  const grid = processing.getCollageLayout('grid', 4, WIDTH, HEIGHT, PADDING, GAP)
  assert.deepStrictEqual(fallback, grid)
})
