const harness = require('./harness')

const assert = harness.assert
const test = harness.test

const media = require('../miniprogram/utils/media')
const exportImage = require('../miniprogram/utils/export-image')
const feedback = require('../miniprogram/utils/feedback')
const rewarded = require('../miniprogram/utils/rewarded')
const config = require('../miniprogram/config/index')

function mockWx(overrides) {
  global.wx = Object.assign(
    {
      showToast: function noop() {},
      showModal: function noop() {},
      openSetting: function noop() {}
    },
    overrides
  )
}

test('media.getImageInfo 透传基础库返回的尺寸', async function () {
  mockWx({
    getImageInfo: function getImageInfo(options) {
      options.success({ width: 1200, height: 800, path: options.src })
    }
  })
  const info = await media.getImageInfo('temp.png')
  assert.strictEqual(info.width, 1200)
  assert.strictEqual(info.height, 800)
})

test('media.getFileInfo 在接口缺失时返回 0 体积', async function () {
  mockWx({})
  const info = await media.getFileInfo('temp.png')
  assert.strictEqual(info.size, 0)
})

test('media.saveImage 拒绝相册权限时给出可读错误', async function () {
  let modalShown = false
  mockWx({
    saveImageToPhotosAlbum: function save(options) {
      options.fail({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' })
    },
    showModal: function show() {
      modalShown = true
    }
  })
  const error = await media.saveImage('temp.png').then(
    function resolved() {
      return null
    },
    function rejected(reason) {
      return reason
    }
  )
  assert(error, '应以错误结束')
  assert.strictEqual(error.code, 'ALBUM_PERMISSION_DENIED')
  assert(error.message.indexOf('相册权限') >= 0)
  assert(modalShown, '应引导用户去设置页授权')
})

test('media.saveImage 成功时不抛错', async function () {
  mockWx({
    saveImageToPhotosAlbum: function save(options) {
      options.success({})
    }
  })
  await media.saveImage('temp.png')
})

test('media.chooseImages 取消选择时返回空数组', async function () {
  mockWx({
    chooseMedia: function choose(options) {
      options.fail({ errMsg: 'chooseMedia:fail cancel' })
    }
  })
  const files = await media.chooseImages(1)
  assert.deepStrictEqual(files, [])
})

test('media.chooseImages 归一化临时文件字段', async function () {
  mockWx({
    chooseMedia: function choose(options) {
      options.success({
        tempFiles: [
          {
            tempFilePath: 'a.png',
            size: 2048,
            fileType: 'image',
            width: 640,
            height: 480
          }
        ]
      })
    }
  })
  const files = await media.chooseImages(2)
  assert.strictEqual(files.length, 1)
  assert.deepStrictEqual(files[0], {
    path: 'a.png',
    size: 2048,
    type: 'image',
    width: 640,
    height: 480
  })
})

test('rewarded.unlockHighQuality 在关闭广告时直接放行', async function () {
  const original = config.enableRewardedAds
  config.enableRewardedAds = false
  const unlocked = await rewarded.unlockHighQuality()
  config.enableRewardedAds = original
  assert.strictEqual(unlocked, true)
})

test('saveWithReward 没有可保存内容时直接返回 false', async function () {
  mockWx({})
  assert.strictEqual(await exportImage.saveWithReward(''), false)
})

test('saveWithReward 关闭广告时直接保存并提示成功', async function () {
  const messages = []
  let savedPath = ''
  const original = config.enableRewardedAds
  config.enableRewardedAds = false
  mockWx({
    saveImageToPhotosAlbum: function save(options) {
      savedPath = options.filePath
      options.success({})
    },
    showToast: function show(options) {
      messages.push(options.title)
    }
  })
  const saved = await exportImage.saveWithReward('result.png')
  config.enableRewardedAds = original
  assert.strictEqual(saved, true)
  assert.strictEqual(savedPath, 'result.png')
  assert(messages.indexOf('已保存到相册') >= 0)
})

test('isCancelled 只识别用户取消', function () {
  assert.strictEqual(exportImage.isCancelled({ errMsg: 'chooseMedia:fail cancel' }), true)
  assert.strictEqual(exportImage.isCancelled({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' }), false)
  assert.strictEqual(exportImage.isCancelled(null), false)
})

test('showError 优先使用错误信息，其次使用兜底文案', function () {
  const messages = []
  const originalLog = console.error
  mockWx({
    showToast: function show(options) {
      messages.push(options.title)
    }
  })
  console.error = function silent() {}
  try {
    feedback.showError(new Error('磁盘已满'))
    feedback.showError({}, '处理失败，请重试')
  } finally {
    console.error = originalLog
  }
  assert.deepStrictEqual(messages, ['磁盘已满', '处理失败，请重试'])
})
