const fs = require('fs')
const path = require('path')
const Module = require('module')
const { assert, test } = require('./harness')

async function invoke(context, env) {
  const names = ['CONTENT_SECURITY_APP_ID', 'CONTENT_SECURITY_CALLBACK_TOKEN', 'CONTENT_SECURITY_CALLBACK_AES_KEY']
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
  const missing = await invoke(context, {})
  assert.strictEqual(missing.ok, false)
  assert.deepStrictEqual(missing.diagnostic, { stage: 'cloud_configuration', reason: 'callback_config_missing' })
  const invalid = await invoke(context, {
    CONTENT_SECURITY_CALLBACK_TOKEN: 'private-callback-token', CONTENT_SECURITY_CALLBACK_AES_KEY: 'invalid-private-key'
  })
  assert.deepStrictEqual(invalid.diagnostic, { stage: 'cloud_configuration', reason: 'callback_config_invalid' })
  assert(!JSON.stringify(invalid).includes('private-callback-token'))
  const wrongApp = await invoke({ APPID: 'wx-another-app', OPENID: 'private-user-identity' }, {})
  assert.deepStrictEqual(wrongApp.diagnostic, { stage: 'cloud_identity', reason: 'appid_mismatch' })
  assert(!JSON.stringify(wrongApp).includes('private-user-identity'))
})
