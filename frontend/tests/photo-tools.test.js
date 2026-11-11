const fs = require('fs')
const path = require('path')
const Module = require('module')
const { assert, test } = require('./harness')
const geometry = require('../miniprogram/utils/photo-layout')
const canvas = require('../miniprogram/utils/canvas')
const media = require('../miniprogram/utils/media')
const security = require('../miniprogram/utils/content-security')
const rewarded = require('../miniprogram/utils/rewarded')
const exporter = require('../miniprogram/utils/export-image')
const feedback = require('../miniprogram/utils/feedback')

function page(name) {
  const filename = path.resolve(__dirname, '../miniprogram/pages/' + name + '/index.js')
  const previous = global.Page
  let definition
  global.Page = value => { definition = value }
  try {
    const mod = new Module(filename, module)
    mod.filename = filename
    mod.paths = Module._nodeModulePaths(path.dirname(filename))
    mod._compile(fs.readFileSync(filename, 'utf8'), filename)
  } finally { global.Page = previous }
  return Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { assert(!this._disposed, 'setData after unload'); Object.assign(this.data, patch) }
  })
}

async function fixture(run) {
  const previousWx = global.wx, restore = []
  const mock = (target, key, value) => {
    const previous = target[key]
    restore.push(() => { target[key] = previous })
    target[key] = value
  }
  const draws = [], fills = [], exports = [], audits = [], saved = [], errors = []
  const context = {
    drawImage(...args) { draws.push(args) },
    fillRect(...args) { fills.push(args) }, clearRect() {}, putImageData() {},
    getImageData(x, y, width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) } },
    createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) } }
  }
  const canvases = []
  global.wx = { showToast() {}, showModal() {}, showLoading() {}, hideLoading() {}, nextTick: fn => fn() }
  mock(canvas, 'createCanvas', (width, height) => { const c = { width, height, getContext: () => context }; canvases.push(c); return c })
  mock(canvas, 'loadImage', async () => ({ width: 2000, height: 1000 }))
  mock(canvas, 'canvasToTempFile', async (c, type) => { exports.push({ width: c.width, height: c.height, type }); return 'output-' + exports.length })
  mock(media, 'getImageInfo', async () => ({ width: 2000, height: 1000, type: 'jpeg' }))
  mock(media, 'getFileInfo', async () => ({ size: 50 }))
  mock(media, 'saveImage', async file => saved.push(file))
  mock(security, 'ensureSafe', async file => audits.push(file))
  mock(rewarded, 'unlockHighQuality', async () => true)
  mock(feedback, 'showError', error => errors.push(error))
  try { await run({ mock, draws, fills, exports, audits, saved, errors, canvases, context }) }
  finally { restore.reverse().forEach(fn => fn()); global.wx = previousWx }
}

function compressedPage(type) {
  const p = page('compress')
  Object.assign(p, { _sourcePath: 'source', _sourceWidth: 2000, _sourceHeight: 1000, _sourceType: type || 'jpeg', _sourceBytes: 100 })
  p.callCompress = async () => { throw new Error('unsupported size options') }
  return p
}

test('工具布局保留横竖原图全部内容，缩小不放大，裁切位置受边界约束', () => {
  assert.deepStrictEqual(geometry.fitInside(4000, 2000, 1280), { width: 1280, height: 640 })
  assert.deepStrictEqual(geometry.fitInside(300, 600, 1280), { width: 300, height: 600 })
  for (const [w, h] of [[2000, 1000], [1000, 2000]]) {
    const contain = geometry.placement(w, h, 1200, 1200, 'contain')
    assert.strictEqual(contain.sw, w); assert.strictEqual(contain.sh, h)
    assert(contain.dw <= 1200 && contain.dh <= 1200)
    for (const anchor of [-5, 0, .5, 1, 5]) {
      const crop = geometry.placement(w, h, 1200, 1200, 'cover', anchor)
      assert(crop.sx >= 0 && crop.sy >= 0 && crop.sx + crop.sw <= w && crop.sy + crop.sh <= h)
    }
  }
  assert.throws(() => geometry.fitInside(0, 1, 900))
})

test('压缩兼容回退仍限制尺寸；原生接口忽略尺寸时也转画布', async () => {
  await fixture(async f => {
    const p = compressedPage()
    p.callCompress = async () => ({ tempFilePath: 'too-large' })
    await p.compressImage()
    assert.deepStrictEqual(f.exports, [{ width: 1280, height: 640, type: 'jpg' }])
    assert.strictEqual(p.data.outputWidth, 1280)
    assert.deepStrictEqual(f.audits, ['output-1'])
    assert.strictEqual(p.data.busy, false)
  })
})

test('PNG 自动格式保留透明区域，显式转 JPG 才铺白底', async () => {
  await fixture(async f => {
    const p = compressedPage('png')
    await p.compressImage()
    assert.strictEqual(f.exports[0].type, 'png'); assert.strictEqual(f.fills.length, 0)
    p.data.format = 'jpg'
    await p.compressImage()
    assert.strictEqual(f.exports[1].type, 'jpg'); assert.strictEqual(f.fills.length, 1)
  })
})

test('自动压缩不会将已达尺寸要求的更小原图替换成更大文件', async () => {
  await fixture(async f => {
    const p = compressedPage('png')
    p._sourceWidth = 400; p._sourceHeight = 200
    f.mock(media, 'getFileInfo', async () => ({ size: 150 }))
    await p.compressImage()
    assert.strictEqual(p.data.resultSrc, 'source')
    assert.strictEqual(p.data.savedPercent, 0)
    assert.deepStrictEqual(f.audits, ['source'])
  })
})

test('压缩审核拒绝不发布结果，未知文件体积不显示虚假压缩率', async () => {
  await fixture(async f => {
    const p = compressedPage()
    f.mock(media, 'getFileInfo', async () => ({ size: 0 }))
    await p.compressImage()
    assert.strictEqual(p.data.savedPercent, 0)
    f.mock(security, 'ensureSafe', async () => { throw new Error('rejected') })
    await p.compressImage()
    assert.strictEqual(p.data.resultSrc, '')
    assert.strictEqual(f.errors.length, 1)
  })
})

test('压缩页面卸载后停止画布生成，不回写页面', async () => {
  await fixture(async f => {
    let resolve
    f.mock(canvas, 'loadImage', () => new Promise(r => { resolve = r }))
    const p = compressedPage('png'), pending = p.compressImage()
    p.onUnload(); resolve({ width: 2000, height: 1000 }); await pending
    assert.strictEqual(f.exports.length, 0)
  })
})

test('拼接排序保留所有图片、拒绝越界并清空失效预览', () => {
  const p = page('collage')
  p.data.images = ['a', 'b', 'c'].map(path => ({ path }))
  p.data.resultSrc = 'old'
  p.moveImage({ currentTarget: { dataset: { index: 1, direction: -1 } } })
  assert.deepStrictEqual(p.data.images.map(i => i.path), ['b', 'a', 'c'])
  assert.strictEqual(p.data.resultSrc, '')
  p.moveImage({ currentTarget: { dataset: { index: 0, direction: -1 } } })
  assert.deepStrictEqual(p.data.images.map(i => i.path), ['b', 'a', 'c'])
})

test('拼接生成期间改变图片顺序会废弃旧结果', async () => {
  await fixture(async f => {
    let resolve
    f.mock(canvas, 'loadImage', () => new Promise(r => { resolve = r }))
    const p = page('collage')
    p.data.images = [{ path: 'a' }, { path: 'b' }]
    const pending = p.generateCollage()
    p.moveImage({ currentTarget: { dataset: { index: 0, direction: 1 } } })
    resolve({ width: 2000, height: 1000 }); await pending
    assert.strictEqual(p.data.resultSrc, ''); assert.strictEqual(f.exports.length, 0)
  })
})

test('拼接完整模式不裁原图，生成后释放画布', async () => {
  await fixture(async f => {
    const p = page('collage'); p.data.images = [{ path: 'a' }]
    await p.generateCollage()
    assert.deepStrictEqual(f.draws[0].slice(1, 5), [0, 0, 2000, 1000])
    assert.strictEqual(p.data.resultSrc, 'output-1')
    assert.strictEqual(f.canvases[0].width, 1)
  })
})

test('九宫格复用一张切片画布，生成9张；右侧裁切与预览一致', async () => {
  await fixture(async f => {
    const p = page('grid'); p._sourcePath = 'source'; p.data.fit = 'cover'; p.data.position = 100
    await p.generateGrid()
    assert.strictEqual(f.canvases.length, 2)
    assert.strictEqual(p.data.cells.length, 9); assert.strictEqual(p.data.progress, 9)
    assert.strictEqual(f.draws[0][1], 1000)
    assert(f.canvases.every(c => c.width === 1))
  })
})

test('九宫格卸载后不继续生成剩余切片', async () => {
  await fixture(async f => {
    const p = page('grid'); p._sourcePath = 'source'
    f.mock(canvas, 'canvasToTempFile', async () => { p.onUnload(); return 'old' })
    await p.generateGrid()
    assert.strictEqual(p.data.cells.length, 0); assert.strictEqual(f.draws.length, 2)
  })
})

test('九宫格保存中断后复检整个批次，只续存剩余文件且不重复广告', async () => {
  await fixture(async f => {
    const p = page('grid'); p.data.cells = Array.from({ length: 9 }, (_, i) => ({ path: '' + i }))
    let failed = false, ads = 0
    f.mock(rewarded, 'unlockHighQuality', async () => { ads++; return true })
    f.mock(media, 'saveImage', async file => {
      if (file === '3' && !failed) { failed = true; throw new Error('album denied') }
      f.saved.push(file)
    })
    await p.saveAll()
    assert.strictEqual(p.data.savedCount, 3)
    await p.saveAll()
    assert.deepStrictEqual(f.saved, ['0','1','2','3','4','5','6','7','8'])
    assert.strictEqual(ads, 1); assert.strictEqual(f.audits.length, 18)
    assert.strictEqual(p.data.saving, false)
  })
})

test('擦除画布保持横图比例，触控两个轴独立映射', async () => {
  await fixture(async f => {
    const p = page('erase')
    p._size = geometry.fitInside(2000, 1000, 900)
    p._sourcePath = 'source'; p._canvas = { getContext: () => f.context }
    await p.drawSource()
    assert.strictEqual(p._canvas.width, 900); assert.strictEqual(p._canvas.height, 450)
    assert.deepStrictEqual(f.draws[0].slice(1), [0, 0, 900, 450])
    p._canvasRect = { left: 10, top: 20, width: 300, height: 200 }
    assert.deepStrictEqual(p.getCanvasPoint({ touches: [{ clientX: 160, clientY: 120 }] }), { x: 450, y: 225 })
  })
})

test('擦除撤销上限后仍标记有修改，重做恢复像素，新笔画清空重做', async () => {
  await fixture(async f => {
    const p = page('erase')
    p._size = { width: 4, height: 4 }; p._canvas = { getContext: () => f.context }
    await p.drawSource()
    for (let i = 1; i <= 6; i++) { p.pushUndoSnapshot(); p._workingData.data[0] = i }
    for (let i = 0; i < 4; i++) p.undo()
    assert.strictEqual(p.data.dirty, true); assert.strictEqual(p.data.canUndo, false)
    assert.strictEqual(p._workingData.data[0], 2)
    p.redo(); assert.strictEqual(p._workingData.data[0], 3)
    p.pushUndoSnapshot(); p.updateHistory(); assert.strictEqual(p.data.canRedo, false)
    const revision = p._revision
    p.data.busy = true; p.undo(); assert.strictEqual(p._revision, revision)
  })
})

test('擦除原图对比不修改工作像素，结束或后台切换恢复编辑状态', async () => {
  await fixture(async f => {
    const p = page('erase')
    p._size = { width: 4, height: 4 }; p._canvas = { getContext: () => f.context }
    await p.drawSource()
    p._workingData.data[0] = 99; p.startCompare()
    assert.strictEqual(p.data.comparing, true); assert.strictEqual(p._workingData.data[0], 99)
    p.onHide(); assert.strictEqual(p.data.comparing, false)
    assert.strictEqual(p._strokeActive, false)
  })
})

test('公共保存互斥阻止重复广告和相册写入，失败后仍可重试', async () => {
  await fixture(async f => {
    let release, ads = 0
    f.mock(rewarded, 'unlockHighQuality', () => { ads++; return new Promise(resolve => { release = resolve }) })
    const pending = exporter.saveWithReward('a')
    await Promise.resolve()
    assert.strictEqual(await exporter.saveWithReward('a'), false)
    release(true); await pending
    assert.strictEqual(ads, 1); assert.deepStrictEqual(f.saved, ['a'])
    f.mock(security, 'ensureSafe', async () => { throw new Error('unavailable') })
    await assert.rejects(exporter.saveWithReward('b'))
    f.mock(security, 'ensureSafe', async () => true)
    f.mock(rewarded, 'unlockHighQuality', async () => true)
    await exporter.saveWithReward('b'); assert.deepStrictEqual(f.saved, ['a', 'b'])
  })
})
