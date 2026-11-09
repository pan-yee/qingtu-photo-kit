const fs = require('fs')
const path = require('path')
const Module = require('module')
const crypto = require('crypto')
const { assert, test } = require('./harness')
const config = require('../miniprogram/config/index')
const shared = require('../miniprogram/utils/content-security')
const media = require('../miniprogram/utils/media')
const canvasTools = require('../miniprogram/utils/canvas')
const exportImage = require('../miniprogram/utils/export-image')

function fresh() {
  const file = path.resolve(__dirname, '../miniprogram/utils/content-security.js')
  const instance = new Module(file, module)
  instance.filename = file; instance.paths = Module._nodeModulePaths(path.dirname(file))
  instance._compile(fs.readFileSync(file, 'utf8'), file)
  return instance.exports
}

async function withClient(options, body) {
  const previousWx = global.wx
  const previousConfig = config.contentSecurity
  const previousEnsure = shared.ensureSafe
  const previousTimeout = global.setTimeout
  const files = new Map([['input.png', Buffer.from('image-input')], ['result.png', Buffer.from('image-result')]])
  let uploads = 0
  let saved = 0
  let previews = 0
  let rpcCalls = 0
  let digest
  let currentPath
  const id = 'a'.repeat(32)
  config.contentSecurity = { envId: 'test-env', functionName: 'contentSecurity' }
  global.wx = {
    showModal: value => { if (value.success) value.success({ confirm: options.consent !== false }) },
    showToast: function () {},
    showLoading: function () {},
    hideLoading: function () {},
    getFileSystemManager: () => ({ getFileInfo(value) {
      const bytes = files.get(value.filePath)
      value.success({ digest: crypto.createHash('sha1').update(bytes).digest('hex'), size: bytes.length })
    } }),
    cloud: {
      init: function () {},
      uploadFile: async value => {
        uploads += 1; currentPath = value.filePath
        digest = crypto.createHash('sha1').update(files.get(value.filePath)).digest('hex')
        return { fileID: 'cloud://test.bucket/' + value.cloudPath }
      },
      deleteFile: async function () {},
      callFunction: async value => {
        rpcCalls += 1
        if (options.networkError) throw new Error('network failure')
        if (value.data.action === 'allocate') return { result: { ok: true, jobId: id, uploadPath: 'moderation-inbox/user/' + id } }
        if (options.mutate) files.set(currentPath, Buffer.from('changed-image'))
        return { result: { ok: options.ok !== false, jobId: id, status: typeof options.status === 'function' ? options.status(currentPath) : options.status || 'pass',
          sha1: options.wrongHash ? '0'.repeat(40) : digest, expiresAt: Date.now() + 60000 } }
      }
    },
    chooseMedia: value => value.success({ tempFiles: [{ tempFilePath: 'input.png', size: 20 }] }),
    canvasToTempFilePath: value => value.success({ tempFilePath: 'result.png' }),
    saveImageToPhotosAlbum: value => { saved += 1; value.success({}) },
    previewImage: () => { previews += 1 }
  }
  if (options.advanceClock) {
    // 让轮询立即运行；Date.now 在该测试体内递增，验证超时而不实际等待一分钟。
    global.setTimeout = function (callback, delay) {
      if (delay === 1500) { queueMicrotask(callback); return 0 }
      return previousTimeout(callback, delay)
    }
  }
  const client = fresh()
  shared.ensureSafe = client.ensureSafe
  try { await body({ client, files, uploads: () => uploads, saved: () => saved,
    previews: () => previews, rpcCalls: () => rpcCalls }) } finally {
    global.wx = previousWx; config.contentSecurity = previousConfig
    shared.ensureSafe = previousEnsure; global.setTimeout = previousTimeout
  }
}

test('未配置云端时保持拦截，不能自动跳过检测', async function () {
  await withClient({}, async function (f) {
    config.contentSecurity.envId = ''
    await assert.rejects(f.client.ensureSafe('input.png'), { code: 'CONTENT_SECURITY_UNAVAILABLE' })
    assert.strictEqual(f.uploads(), 0)
  })
})

test('用户拒绝检测时不上传图片', async function () {
  await withClient({ consent: false }, async function (f) {
    await assert.rejects(f.client.ensureSafe('input.png'), { code: 'CONTENT_SECURITY_CANCELLED' })
    assert.strictEqual(f.uploads(), 0)
    assert.strictEqual(f.rpcCalls(), 0)
  })
})

test('只有明确通过且字节摘要匹配才允许保存，相同图片复用结果', async function () {
  await withClient({}, async function (f) {
    await media.chooseImages(1)
    await media.saveImage('input.png')
    assert.strictEqual(f.saved(), 1)
    assert.strictEqual(f.uploads(), 1)
    f.files.set('input.png', Buffer.from('updated-image'))
    await media.saveImage('input.png')
    assert.strictEqual(f.uploads(), 2)
  })
})

test('违规图片在选图、画布结果、激励广告保存和大图预览处均被拦截', async function () {
  await withClient({ status: 'reject' }, async function (f) {
    await assert.rejects(media.chooseImages(1), { code: 'CONTENT_SECURITY_REJECTED', message: '所发布内容含违规信息' })
    await assert.rejects(canvasTools.canvasToTempFile({}, 'png', 1), { code: 'CONTENT_SECURITY_REJECTED' })
    await assert.rejects(exportImage.saveWithReward('result.png'), { code: 'CONTENT_SECURITY_REJECTED' })
    const previousLog = console.error; console.error = function () {}
    try { await media.previewImage('result.png') } finally { console.error = previousLog }
    assert.strictEqual(f.saved(), 0)
    assert.strictEqual(f.previews(), 0)
  })
})

test('服务异常、错误摘要、未知状态和检测期间文件被替换均不放行', async function () {
  for (const options of [{ networkError: true }, { wrongHash: true }, { status: 'unknown' }, { mutate: true }, { ok: false }]) {
    await withClient(options, async function (f) {
      await assert.rejects(media.saveImage('input.png'), { code: 'CONTENT_SECURITY_UNAVAILABLE' })
      assert.strictEqual(f.saved(), 0)
    })
  }
})

test('pending 不视为通过，超时仍禁止导出', async function () {
  const previousNow = Date.now
  await withClient({ status: 'pending', advanceClock: true }, async function (f) {
    let time = previousNow()
    Date.now = () => { time += 15000; return time }
    try {
      await assert.rejects(media.saveImage('input.png'), { code: 'CONTENT_SECURITY_PENDING' })
      assert.strictEqual(f.saved(), 0)
    } finally { Date.now = previousNow }
  })
})

function gridPage() {
  const file = path.resolve(__dirname, '../miniprogram/pages/grid/index.js')
  let options
  const previousPage = global.Page
  global.Page = function (value) { options = value }
  try {
    const instance = new Module(file, module)
    instance.filename = file; instance.paths = Module._nodeModulePaths(path.dirname(file))
    instance._compile(fs.readFileSync(file, 'utf8'), file)
  } finally { global.Page = previousPage }
  const page = Object.assign({}, options)
  page.data = Object.assign({}, options.data)
  page.setData = function (patch) { Object.assign(this.data, patch) }
  return page
}

test('九宫格先检测完整批次，其中一张违规时不会先保存前面的图片', async function () {
  await withClient({ status: path => path === 'grid-5.png' ? 'reject' : 'pass' }, async function (f) {
    const page = gridPage()
    page.data.cells = Array.from({ length: 9 }, function (_, index) {
      const path = 'grid-' + index + '.png'
      f.files.set(path, Buffer.from('grid-image-' + index))
      return { path, index: index + 1 }
    })
    const previousLog = console.error; console.error = function () {}
    try { await page.saveAll() } finally { console.error = previousLog }
    assert.strictEqual(f.saved(), 0)
    assert.strictEqual(f.uploads(), 6)
    assert.strictEqual(page._saving, false)
  })
})

test('九宫格全部通过后保存 9 张，保存阶段复用逐张摘要结果', async function () {
  await withClient({}, async function (f) {
    const page = gridPage()
    page.data.cells = Array.from({ length: 9 }, function (_, index) {
      const path = 'grid-' + index + '.png'
      f.files.set(path, Buffer.from('grid-image-' + index))
      return { path, index: index + 1 }
    })
    await page.saveAll()
    assert.strictEqual(f.saved(), 9)
    assert.strictEqual(f.uploads(), 9)
  })
})
