const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { assert, test } = require('./harness')
const media = require('../miniprogram/utils/media')

function component() {
  let options
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,
    '../miniprogram/components/privacy-dialog/index.js'), 'utf8'), {
    wx: global.wx, Set: Set, Component: function (value) { options = value }
  })
  const instance = Object.assign({ data: Object.assign({}, options.data) }, options.methods)
  instance.setData = function (patch) { Object.assign(this.data, patch) }
  return { instance: instance, options: options }
}

test('拒绝隐私授权后不调用选图或保存接口', async function () {
  const previous = global.wx
  let privateCalls = 0
  global.wx = {
    getPrivacySetting: function (options) { options.success({ needAuthorization: true }) },
    requirePrivacyAuthorize: function (options) {
      options.fail({ errMsg: 'requirePrivacyAuthorize:fail privacy permission is not authorized' })
    },
    chooseMedia: function () { privateCalls += 1 },
    saveImageToPhotosAlbum: function () { privateCalls += 1 }
  }
  try {
    await assert.rejects(media.chooseImages(1), { code: 'PRIVACY_AUTH_DENIED' })
    await assert.rejects(media.saveImage('local.png'), { code: 'PRIVACY_AUTH_DENIED' })
    assert.strictEqual(privateCalls, 0)
  } finally { global.wx = previous }
})

test('隐私状态查询失败不会绕过检查调用选图', async function () {
  const previous = global.wx
  let calls = 0
  global.wx = {
    getPrivacySetting: function (options) { options.fail(new Error('隐私状态不可用')) },
    chooseMedia: function () { calls += 1 }
  }
  try {
    await assert.rejects(media.chooseImages(), /隐私状态不可用/)
    assert.strictEqual(calls, 0)
  } finally { global.wx = previous }
})

test('自定义隐私弹窗同意后结算所有等待接口，拒绝后仍可浏览', function () {
  const previous = global.wx
  let listener
  global.wx = { onNeedPrivacyAuthorization: function (callback) { listener = callback } }
  try {
    const { instance, options } = component()
    options.lifetimes.attached.call(instance)
    const results = []
    listener(function (result) { results.push(result) })
    listener(function (result) { results.push(result) })
    assert.strictEqual(instance.data.visible, true)
    instance.agreePrivacy()
    assert.strictEqual(results.length, 2)
    for (const result of results) {
      assert.strictEqual(result.event, 'agree')
      assert.strictEqual(result.buttonId, 'privacy-agree-button')
    }
    assert.strictEqual(instance.data.visible, false)
    listener(function (result) { results.push(result) })
    instance.refusePrivacy()
    assert.strictEqual(results[2].event, 'disagree')
    assert.strictEqual(instance.data.visible, false)
    listener(function (result) { results.push(result) })
    options.pageLifetimes.hide.call(instance)
    assert.strictEqual(results[3].event, 'disagree')
    options.lifetimes.detached.call(instance)
    assert.strictEqual(results.length, 4, '不能重复结算同一个隐私请求')
  } finally { global.wx = previous }
})

test('仅浏览不主动弹出授权；拒绝后的延迟查询不会重新打开弹窗', function () {
  const previous = global.wx
  let listener
  let query
  global.wx = {
    onNeedPrivacyAuthorization: function (callback) { listener = callback },
    getPrivacySetting: function (options) { query = options }
  }
  try {
    const { instance, options } = component()
    options.lifetimes.attached.call(instance)
    assert.strictEqual(query, undefined)
    assert.strictEqual(instance.data.visible, false)
    listener(function () {})
    assert.strictEqual(instance.data.visible, true)
    instance.refusePrivacy()
    query.success({ needAuthorization: true, privacyContractName: '隐私说明' })
    assert.strictEqual(instance.data.visible, false)
  } finally { global.wx = previous }
})
