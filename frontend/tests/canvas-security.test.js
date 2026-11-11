const { assert, test } = require('./harness')
const security = require('../miniprogram/utils/content-security')
const canvas = require('../miniprogram/utils/canvas')

test('内部导出校验原图，公开导出校验结果，审核失败时不导出内部文件', async function () {
  const saved = { wx: global.wx, ensureSafe: security.ensureSafe }
  const checked = []
  let exports = 0
  global.wx = { canvasToTempFilePath(options) {
    exports += 1
    options.success({ tempFilePath: 'derivative.png' })
  } }
  security.ensureSafe = async path => { checked.push(path) }
  try {
    assert.strictEqual(await canvas.canvasToProcessingFile({}, 'original.jpg'), 'derivative.png')
    assert.deepStrictEqual(checked, ['original.jpg'])
    await canvas.canvasToTempFile({})
    assert.deepStrictEqual(checked, ['original.jpg', 'derivative.png'])
    security.ensureSafe = async () => { throw new Error('内容含违规信息') }
    await assert.rejects(canvas.canvasToProcessingFile({}, 'unsafe.jpg'), /违规/)
    assert.strictEqual(exports, 2)
    await assert.rejects(canvas.canvasToProcessingFile({}), /原图/)
  } finally { global.wx = saved.wx; security.ensureSafe = saved.ensureSafe }
})
