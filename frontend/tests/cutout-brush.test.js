const fs = require('fs')
const path = require('path')
const Module = require('module')
const harness = require('./harness')

const assert = harness.assert
const contentSecurity = require('../miniprogram/utils/content-security')
// 此文件隔离测试相册/页面行为；真实内容安全链路在 content-security.test.js 中覆盖。
function test(name, fn) {
  harness.test(name, async function () {
    const config = require('../miniprogram/config/index')
    const previousBackend = config.portraitBackend
    config.portraitBackend = 'local'
    const saved = contentSecurity.ensureSafe
    contentSecurity.ensureSafe = async function () {}
    try { await fn() } finally { contentSecurity.ensureSafe = saved; config.portraitBackend = previousBackend }
  })
}

const PHOTO_WIDTH = 900
const PHOTO_HEIGHT = 1200
const PAGE_FILE = path.join(
  __dirname,
  '..',
  'miniprogram',
  'pages',
  'cutout',
  'index.js'
)

// 白墙 + 红色主体，和真实照片一样走完整的分割流程。
function buildPhoto() {
  const data = new Uint8ClampedArray(PHOTO_WIDTH * PHOTO_HEIGHT * 4)
  for (let y = 0; y < PHOTO_HEIGHT; y += 1) {
    for (let x = 0; x < PHOTO_WIDTH; x += 1) {
      const offset = (y * PHOTO_WIDTH + x) * 4
      const inSubject = x >= 300 && x < 600 && y >= 300 && y < 900
      data[offset] = inSubject ? 210 : 248
      data[offset + 1] = inSubject ? 35 : 248
      data[offset + 2] = inSubject ? 55 : 244
      data[offset + 3] = 255
    }
  }
  return data
}

const photo = buildPhoto()

function createImageStub() {
  const image = { width: PHOTO_WIDTH, height: PHOTO_HEIGHT }
  Object.defineProperty(image, 'src', {
    set: function ignored() {
      setTimeout(function loaded() {
        if (image.onload) image.onload()
      }, 0)
    }
  })
  return image
}

function createContextStub() {
  return {
    drawn: 0,
    fillStyle: '#000000',
    clearRect() {},
    fillRect() {},
    fill() {},
    clip() {},
    save() {},
    restore() {},
    beginPath() {},
    arc() {},
    drawImage() {
      this.drawn += 1
    },
    createImageData(width, height) {
      return {
        data: new Uint8ClampedArray(width * height * 4),
        width: width,
        height: height
      }
    },
    getImageData() {
      return {
        data: new Uint8ClampedArray(photo),
        width: PHOTO_WIDTH,
        height: PHOTO_HEIGHT
      }
    },
    putImageData() {}
  }
}

function createCanvasStub() {
  const context = createContextStub()
  return {
    width: 0,
    height: 0,
    getContext: function getContext() {
      return context
    },
    createImage: createImageStub
  }
}

// 375 CSS 宽、2 倍屏的画布：缓冲区 600×800。
const pageCanvas = createCanvasStub()

function installWx() {
  const saved = global.wx
  global.wx = {
    getWindowInfo: function getWindowInfo() {
      return { pixelRatio: 2 }
    },
    getSystemInfoSync: function getSystemInfoSync() {
      return { pixelRatio: 2 }
    },
    createOffscreenCanvas: function createOffscreenCanvas(options) {
      const canvas = createCanvasStub()
      canvas.width = options.width || 0
      canvas.height = options.height || 0
      return canvas
    },
    createSelectorQuery: function createSelectorQuery() {
      return {
        select: function select() {
          return {
            fields: function fields() {
              return {
                exec: function exec(callback) {
                  callback([
                    {
                      node: pageCanvas,
                      width: 300,
                      height: 400,
                      left: 0,
                      top: 0
                    }
                  ])
                }
              }
            }
          }
        }
      }
    },
    canvasToTempFilePath: function canvasToTempFilePath(options) {
      setTimeout(function done() {
        options.success({ tempFilePath: 'tmp-result.png' })
      }, 0)
    },
    showToast: function showToast() {},
    getFileSystemManager: function () { return { unlink() {} } },
    getImageInfo: function getImageInfo(options) {
      options.success({ width: PHOTO_WIDTH, height: PHOTO_HEIGHT })
    }
  }
  return function restore() {
    global.wx = saved
  }
}

/**
 * 在独立的 Module 里编译页面，避免和 pages.test.js 抢全局 Page 与模块缓存。
 */
function loadPage() {
  let options = null
  const previousPage = global.Page
  global.Page = function register(definition) {
    options = definition
  }
  const mod = new Module(PAGE_FILE, null)
  mod.filename = PAGE_FILE
  mod.paths = Module._nodeModulePaths(path.dirname(PAGE_FILE))
  mod._compile(fs.readFileSync(PAGE_FILE, 'utf8'), PAGE_FILE)
  global.Page = previousPage
  return options
}

function createPageInstance(options) {
  const page = Object.create(options)
  page.data = JSON.parse(JSON.stringify(options.data))
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch)
    if (callback) callback.call(this)
  }
  return page
}

function alphaAt(page, x, y) {
  return page._cutoutImageData.data[(y * PHOTO_WIDTH + x) * 4 + 3]
}

function touch(point) {
  return { touches: [point], changedTouches: [point] }
}

test('抠图页涂抹流程：切到修正模式、擦除、撤销', async function () {
  const restoreWx = installWx()
  try {
    const page = createPageInstance(loadPage())
    await page.preparePhoto('tmp-source.png')

    assert.strictEqual(page.data.hasImage, true, '选图后应进入工作态')
    assert.strictEqual(page.data.resultSrc, 'tmp-result.png', '应产出预览图')
    assert.strictEqual(alphaAt(page, 450, 600), 255, '主体中心应不透明')
    assert.strictEqual(alphaAt(page, 20, 20), 0, '墙面应被移除')

    // 进入修正模式：画布缓冲区按 2 倍屏设置，并已把结果画上去。
    page.toggleBrush()
    assert.strictEqual(page.data.brushMode, true, '应进入涂抹模式')
    assert.strictEqual(page.data.canUndoBrush, false, '还没涂过不能撤销')
    assert.strictEqual(pageCanvas.width, 600, '画布缓冲区按屏幕密度放大')
    assert.strictEqual(pageCanvas.height, 800)
    assert(pageCanvas.getContext('2d').drawn > 0, '进入时应把结果画到画布')

    // 手指落在画布正中，对应照片 (450, 600)。
    page.onBrushTouchStart(touch({ x: 150, y: 200 }))
    assert.strictEqual(
      page._brushMask[600 * PHOTO_WIDTH + 450],
      2,
      '涂抹应写入擦除标记'
    )
    assert.strictEqual(page.data.canUndoBrush, true, '涂过后应可撤销')
    assert.strictEqual(page._maskUndo.length, 1, '一笔只留一个撤销点')

    await page.onBrushTouchEnd()
    assert.strictEqual(alphaAt(page, 450, 600), 0, '涂抹处应从结果里去掉')
    assert.strictEqual(alphaAt(page, 350, 600), 255, '没涂到的主体应保留')

    await page.undoBrush()
    assert.strictEqual(alphaAt(page, 450, 600), 255, '撤销后应恢复主体')
    assert.strictEqual(page.data.canUndoBrush, false, '撤销栈空了要禁用按钮')

    await page.resetBrush()
    assert.strictEqual(page.data.brushMode, true, '清除涂改不退出涂抹模式')
  } finally {
    restoreWx()
  }
})

test('找回主体：涂抹记录在换底色后仍然生效', async function () {
  const restoreWx = installWx()
  try {
    const page = createPageInstance(loadPage())
    await page.preparePhoto('tmp-source.png')
    page.toggleBrush()

    // 先用擦除切掉一块，再换工具在别处找回主体。
    page.chooseBrushTool({ currentTarget: { dataset: { tool: 'restore' } } })
    assert.strictEqual(page.data.brushTool, 'restore', '应切换到找回工具')
    page.onBrushTouchStart(touch({ x: 150, y: 200 }))
    assert.strictEqual(
      page._brushMask[600 * PHOTO_WIDTH + 450],
      1,
      '找回工具应写入保留标记'
    )
    await page.onBrushTouchEnd()

    page.chooseBackground({ currentTarget: { dataset: { key: 'blue' } } })
    await new Promise(function wait(resolve) {
      setTimeout(resolve, 0)
    })
    assert.strictEqual(page.data.backgroundKey, 'blue', '应切换到蓝色底')
    assert.strictEqual(alphaAt(page, 450, 600), 255, '换底色后修正仍生效')

    // 换照片时遮罩和撤销栈一起重建。
    await page.preparePhoto('tmp-source.png')
    assert.strictEqual(
      page._brushMask[600 * PHOTO_WIDTH + 450],
      0,
      '换照片应清空旧涂改'
    )
    assert.strictEqual(page._maskUndo.length, 0)
    assert.strictEqual(page.data.canUndoBrush, false)
  } finally {
    restoreWx()
  }
})

test('人像分割每张照片只推理一次，换底色与尺寸复用遮罩', async function () {
  const restoreWx = installWx()
  let runs = 0
  let destroyed = false
  const mask = new Float32Array(256 * 256)
  for (let y = 64; y < 192; y += 1) {
    for (let x = 80; x < 176; x += 1) mask[y * 256 + x] = 1
  }
  wx.createInferenceSession = function () {
    return {
      onLoad: function (callback) { queueMicrotask(callback) },
      onError: function () {},
      run: async function () {
        runs += 1
        return { activation_10: { type: 'float32', shape: [1, 1, 256, 256], data: mask.buffer } }
      },
      destroy: function () { destroyed = true }
    }
  }
  const page = createPageInstance(loadPage())
  try {
    await page.preparePhoto('tmp-source.png')
    assert.strictEqual(page.data.portraitMode, true)
    assert.strictEqual(page.data.engineNotice, '')
    assert.strictEqual(alphaAt(page, 450, 600), 255)
    assert.strictEqual(alphaAt(page, 20, 20), 0)
    assert.strictEqual(page._outputCanvas.width, 295)
    assert.strictEqual(page._outputCanvas.height, 413)
    const cached = page._portraitMask
    await page.choosePhotoSize({ currentTarget: { dataset: { key: 'two-inch' } } })
    assert.strictEqual(page._outputCanvas.width, 413)
    assert.strictEqual(page._outputCanvas.height, 579)
    assert.strictEqual(page.data.photoSizeLabel, '二寸')
    page.data.backgroundKey = 'red'
    await page.renderResult()
    assert.strictEqual(page._portraitMask, cached)
    assert.strictEqual(runs, 1)
    page.onUnload()
    assert.strictEqual(destroyed, true)
  } finally { page.onUnload(); restoreWx() }
})

test('人像模型不支持时明确提示基础换底色，不冒充模型结果', async function () {
  const restoreWx = installWx()
  const page = createPageInstance(loadPage())
  try {
    await page.preparePhoto('tmp-source.png')
    assert.strictEqual(page.data.portraitMode, false)
    assert(page.data.engineNotice.includes('基础换底色'))
    assert.strictEqual(page.data.resultSrc, 'tmp-result.png')
  } finally { page.onUnload(); restoreWx() }
})

test('模型加载期间离开页面会销毁会话，不再更新已销毁页面', async function () {
  const restoreWx = installWx()
  let startLoad
  const started = new Promise(function (resolve) { startLoad = resolve })
  let destroyed = false
  wx.createInferenceSession = function () {
    startLoad()
    return {
      onLoad: function () {}, onError: function () {},
      destroy: function () { destroyed = true }
    }
  }
  const page = createPageInstance(loadPage())
  try {
    const pending = page.preparePhoto('tmp-source.png')
    await started
    page.onUnload()
    page.setData = function () { throw new Error('卸载后不应更新页面') }
    await pending
    assert.strictEqual(destroyed, true)
    assert.strictEqual(page._portraitMask, null)
  } finally { restoreWx() }
})

test('模型明确没有识别人像时提示重新选图，不偷偷改用颜色算法', async function () {
  const restoreWx = installWx()
  wx.createInferenceSession = function () {
    return {
      onLoad: function (callback) { queueMicrotask(callback) }, onError: function () {},
      run: async function () {
        return { activation_10: { type: 'float32', shape: [1, 1, 256, 256],
          data: new Float32Array(256 * 256).buffer } }
      },
      destroy: function () {}
    }
  }
  const page = createPageInstance(loadPage())
  try {
    await assert.rejects(page.preparePhoto('tmp-source.png'), { code: 'NO_PORTRAIT' })
    assert.strictEqual(page.data.hasImage, false)
    assert.strictEqual(page.data.processing, false)
    assert.strictEqual(page.data.resultSrc, '')
    assert.strictEqual(page.data.engineNotice, '')
  } finally { page.onUnload(); restoreWx() }
})

test('ECS 抠图失败时不降级为颜色抠除，也不输出破损照片', async function () {
  const restoreWx = installWx()
  const remote = require('../miniprogram/utils/portrait-remote')
  const previous = remote.segment
  require('../miniprogram/config/index').portraitBackend = 'ecs'
  remote.segment = async function () { throw new Error('抠图服务暂不可用') }
  const page = createPageInstance(loadPage())
  try {
    await assert.rejects(page.preparePhoto('tmp-source.png'), /暂不可用/)
    assert.strictEqual(page.data.hasImage, false)
    assert.strictEqual(page.data.resultSrc, '')
    assert.strictEqual(page._portraitMask, null)
    assert.strictEqual(page._borderColors, undefined)
  } finally { page.onUnload(); remote.segment = previous; restoreWx() }
})

test('ECS 连续遮罩复用，换底色和尺寸不会重新上传人像', async function () {
  const restoreWx = installWx()
  const remote = require('../miniprogram/utils/portrait-remote')
  const previous = remote.segment
  require('../miniprogram/config/index').portraitBackend = 'ecs'
  let runs = 0
  remote.segment = async function () {
    runs += 1
    return { data: new Float32Array(32 * 32).fill(.75), width: 32, height: 32, matting: true }
  }
  const page = createPageInstance(loadPage())
  try {
    await page.preparePhoto('tmp-source.png')
    assert.strictEqual(page.data.portraitMode, true)
    assert(alphaAt(page, 450, 600) > 180 && alphaAt(page, 450, 600) < 255)
    await page.choosePhotoSize({ currentTarget: { dataset: { key: 'two-inch' } } })
    page.data.backgroundKey = 'red'
    await page.renderResult()
    assert.strictEqual(runs, 1)
  } finally { page.onUnload(); remote.segment = previous; restoreWx() }
})

test('ECS 完整宽幅图先推理，内部 JPEG 不额外审核，最终 PNG 必须审核', async function () {
  const restoreWx = installWx()
  const remote = require('../miniprogram/utils/portrait-remote')
  const previous = remote.segment
  const previousCheck = contentSecurity.ensureSafe
  const checked = [], canvases = [], exports = []
  const createCanvas = wx.createOffscreenCanvas
  const exportCanvas = wx.canvasToTempFilePath
  require('../miniprogram/config/index').portraitBackend = 'ecs'
  wx.getImageInfo = options => options.success({ width: 2000, height: 1000 })
  wx.createOffscreenCanvas = options => { canvases.push([options.width, options.height]); return createCanvas(options) }
  wx.canvasToTempFilePath = options => { exports.push(options.fileType); exportCanvas(options) }
  contentSecurity.ensureSafe = async path => { checked.push(path) }
  remote.segment = async () => ({ matting: true, width: 32, height: 32,
    data: new Float32Array(1024).fill(1), face: { x: .1, y: .2, width: .1, height: .2 } })
  const page = createPageInstance(loadPage())
  try {
    await page.preparePhoto('tmp-source.png')
    assert(canvases.some(size => size[0] === 1600 && size[1] === 800))
    assert.deepStrictEqual(exports, ['jpg', 'png'])
    assert.deepStrictEqual(checked, ['tmp-source.png', 'tmp-result.png'])
    assert(page.data.engineNotice.includes('辅助构图'))
    assert.strictEqual(page.data.resultSrc, 'tmp-result.png')
  } finally {
    page.onUnload(); remote.segment = previous
    contentSecurity.ensureSafe = previousCheck; restoreWx()
  }
})
