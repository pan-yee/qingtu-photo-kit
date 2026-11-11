const fs = require('fs')
const path = require('path')
const Module = require('module')
const { assert, test } = require('./harness')

async function invoke(context, env) {
  const names = ['CONTENT_SECURITY_APP_ID', 'CONTENT_SECURITY_CALLBACK_TOKEN', 'CONTENT_SECURITY_CALLBACK_AES_KEY', 'CONTENT_SECURITY_AUDIT_MODE']
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  const file = path.resolve(__dirname, '../cloudfunctions/contentSecurity/index.js')
  try {
    for (const name of names) {
      if (env[name] === undefined) delete process.env[name]
      else process.env[name] = env[name]
    }
    const instance = new Module(file, module)
    instance.filename = file; instance.paths = Module._nodeModulePaths(path.dirname(file))
    instance.require = function (target) {
      if (target === 'wx-server-sdk') return { init() {}, getWXContext: () => context,
        database: () => ({ collection: () => ({}) }) }
      return Module.prototype.require.call(this, target)
    }
    instance._compile(fs.readFileSync(file, 'utf8'), file)
    return await instance.exports.main({ action: 'allocate', status: 'pass' })
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  }
}

test('云函数缺少回调配置或身份不匹配时返回有限诊断，不暴露配置值且不放行', async function () {
  const context = { APPID: 'wx2b68d0818781b66d', OPENID: 'private-user-identity' }
  const missing = await invoke(context, { CONTENT_SECURITY_AUDIT_MODE: 'async' })
  assert.strictEqual(missing.ok, false)
  assert.deepStrictEqual(missing.diagnostic, { stage: 'cloud_configuration', reason: 'callback_config_missing' })
  const invalid = await invoke(context, {
    CONTENT_SECURITY_AUDIT_MODE: 'async', CONTENT_SECURITY_CALLBACK_TOKEN: 'private-callback-token', CONTENT_SECURITY_CALLBACK_AES_KEY: 'invalid-private-key'
  })
  assert.deepStrictEqual(invalid.diagnostic, { stage: 'cloud_configuration', reason: 'callback_config_invalid' })
  assert(!JSON.stringify(invalid).includes('private-callback-token'))
  const wrongApp = await invoke({ APPID: 'wx-another-app', OPENID: 'private-user-identity' }, {})
  assert.deepStrictEqual(wrongApp.diagnostic, { stage: 'cloud_identity', reason: 'appid_mismatch' })
  assert(!JSON.stringify(wrongApp).includes('private-user-identity'))
})

test('默认同步云模式不依赖回调配置，但数据库异常仍不放行', async function () {
  const result = await invoke({ APPID: 'wx2b68d0818781b66d', OPENID: 'openid_user_123456' }, {})
  assert.strictEqual(result.ok, false)
  assert.deepStrictEqual(result.diagnostic, { stage: 'cloud_allocate', reason: 'service_rejected' })
})

test('云同步审核仅接受微信明确数字成功码，并将明确违规映射为拒绝', async function () {
  const { createCloudImageCheck } = require('../cloudfunctions/contentSecurity/cloud-image-check')
  const original = Buffer.from('original-image')
  const copy = Buffer.from('jpeg-audit-copy')
  for (const [result, expected] of [[{ errCode: 0 }, 0], [{ errcode: 0 }, 0], [{ errCode: 87014 }, 87014]]) {
    const cloud = { openapi: { security: { imgSecCheck: async input => {
      assert.strictEqual(input.media.contentType, 'image/jpeg')
      assert.deepStrictEqual(input.media.value, copy)
      return result
    } } } }
    const check = createCloudImageCheck(cloud, async value => { assert.strictEqual(value, original); return copy })
    assert.deepStrictEqual(await check(original), { errcode: expected })
  }
  for (const result of [{}, { errCode: '0' }, { errCode: -1 }, null]) {
    const check = createCloudImageCheck({ openapi: { security: { imgSecCheck: async () => result } } }, async () => copy)
    await assert.rejects(check(original))
  }
  const risk = new Error('rejected'); risk.errCode = 87014
  const reject = createCloudImageCheck({ openapi: { security: { imgSecCheck: async () => { throw risk } } } }, async () => copy)
  assert.deepStrictEqual(await reject(original), { errcode: 87014 })
})

test('云检测副本保持画面比例，符合尺寸体积限制并拒绝损坏图片', async function () {
  const sharp = require('sharp')
  const { prepareAuditImage } = require('../cloudfunctions/contentSecurity/audit-image')
  const image = await sharp({ create: { width: 1800, height: 2400, channels: 4,
    background: { r: 40, g: 120, b: 80, alpha: 0.7 } } }).png().toBuffer()
  const output = await prepareAuditImage(image)
  const metadata = await sharp(output).metadata()
  assert.strictEqual(metadata.format, 'jpeg')
  assert(metadata.width <= 750 && metadata.height <= 1334 && output.length < 1024 * 1024)
  assert(Math.abs(metadata.width / metadata.height - 0.75) < 0.002)
  await assert.rejects(prepareAuditImage(Buffer.from([255, 216, 255, 1, 2])))
  const oversized = await sharp({ create: { width: 5001, height: 5000, channels: 3,
    background: '#389169' } }).png().toBuffer()
  await assert.rejects(prepareAuditImage(oversized))
})
