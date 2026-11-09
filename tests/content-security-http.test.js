const fs = require('fs')
const path = require('path')
const Module = require('module')
const crypto = require('crypto')
const { assert, test } = require('./harness')
const config = require('../miniprogram/config/index')

function fresh(name, transport) {
  const file = path.resolve(__dirname, '../miniprogram/utils/' + name + '.js')
  const instance = new Module(file, module)
  instance.filename = file; instance.paths = Module._nodeModulePaths(path.dirname(file))
  instance.require = function (target) {
    return target === './moderation-http' && transport ? transport : Module.prototype.require.call(this, target)
  }
  instance._compile(fs.readFileSync(file, 'utf8'), file)
  return instance.exports
}
async function withHttp(options, body) {
  const previousWx = global.wx
  const previousConfig = config.contentSecurity
  let bytes = Buffer.from([255, 216, 255, 1, 2])
  let digest = ''
  let logins = 0
  let uploads = 0
  let requests = 0
  let cleanup = 0
  let denied = false
  const id = 'b'.repeat(32)
  const uploadPath = 'moderation-inbox/openid_user_123456/' + id
  config.contentSecurity = { backend: 'http', apiBaseUrl: 'https://photos.example/qingtu-api' }
  global.wx = {
    showModal: value => value.success({ confirm: !options.refuse }),
    showLoading() {}, hideLoading() {},
    login: value => { logins += 1; value.success({ code: 'wx-code-123456' }) },
    getFileSystemManager: () => ({
      getFileInfo(value) { value.success({ digest: crypto.createHash('sha1').update(bytes).digest('hex'), size: bytes.length }) },
      readFile(value) { value.success({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }) }
    }),
    request(value) {
      requests += 1
      assert(value.url.startsWith('https://photos.example/qingtu-api/'))
      if (options.networkError) { value.fail(new Error('offline')); return }
      if (value.url.endsWith('/session')) {
        assert.deepStrictEqual(value.data, { code: 'wx-code-123456' })
        value.success({ statusCode: 200, data: { ok: true, token: 'signed-session-' + logins, expiresIn: 3600 } }); return
      }
      assert(/^Bearer signed-session-/.test(value.header.Authorization))
      if (options.unauthorizedOnce && !denied) { denied = true; value.success({ statusCode: 401 }); return }
      let result
      if (value.url.endsWith('/jobs')) result = { ok: true, jobId: id, uploadPath }
      else if (value.url.endsWith('/image') && value.method === 'POST') {
        assert.strictEqual(value.header['Content-Type'], 'application/octet-stream')
        assert(value.data instanceof ArrayBuffer)
        uploads += 1; digest = crypto.createHash('sha1').update(Buffer.from(value.data)).digest('hex')
        result = { ok: true, fileId: uploadPath }
        if (options.mutate) bytes = Buffer.from('modified')
      } else if (value.url.endsWith('/image') && value.method === 'DELETE') { cleanup += 1; result = { ok: true } }
      else result = { ok: true, jobId: id, sha1: options.badDigest ? '0'.repeat(40) : digest,
        status: options.status || 'pass', expiresAt: Date.now() + 60000 }
      value.success({ statusCode: 200, data: result })
    }
  }
  const transport = fresh('moderation-http')
  const client = fresh('content-security', transport)
  try { await body({ client, transport, logins: () => logins, uploads: () => uploads,
    requests: () => requests, cleanup: () => cleanup }) }
  finally { global.wx = previousWx; config.contentSecurity = previousConfig }
}

test('自有服务器：无 wx.cloud 也能登录、上传真实字节、核验摘要并复用通过结果', async function () {
  await withHttp({}, async function (f) {
    await f.client.ensureSafe('test.jpg')
    await f.client.ensureSafe('test.jpg')
    assert.strictEqual(f.logins(), 1)
    assert.strictEqual(f.uploads(), 1)
    assert.strictEqual(f.cleanup(), 1)
  })
})
test('自有服务器：拒绝上传同意时不登录、不上传', async function () {
  await withHttp({ refuse: true }, async function (f) {
    await assert.rejects(f.client.ensureSafe('test.jpg'), { code: 'CONTENT_SECURITY_CANCELLED' })
    assert.strictEqual(f.requests(), 0)
    assert.strictEqual(f.logins(), 0)
  })
})
test('自有服务器：拒绝、摘要不符、文件变化、网络错误及未知状态都不放行', async function () {
  for (const options of [{ status: 'reject' }, { badDigest: true }, { mutate: true },
    { networkError: true }, { status: 'unknown' }]) {
    await withHttp(options, async function (f) {
      await assert.rejects(f.client.ensureSafe('test.jpg'), {
        code: options.status === 'reject' ? 'CONTENT_SECURITY_REJECTED' : 'CONTENT_SECURITY_UNAVAILABLE'
      })
    })
  }
})
test('自有服务器：401 后重新登录一次，不能自动切换为免检或云函数', async function () {
  await withHttp({ unauthorizedOnce: true }, async function (f) {
    await f.client.ensureSafe('test.jpg')
    assert.strictEqual(f.logins(), 2)
    assert.strictEqual(f.uploads(), 1)
  })
})
test('自有服务器：拒绝非 HTTPS、用户信息和查询参数形式的后台地址', async function () {
  await withHttp({}, async function (f) {
    for (const url of ['http://photos.example', 'https://user:pass@photos.example', 'https://photos.example?target=evil']) {
      config.contentSecurity.apiBaseUrl = url
      await assert.rejects(f.client.ensureSafe('test.jpg'), { code: 'CONTENT_SECURITY_UNAVAILABLE' })
    }
    assert.strictEqual(f.requests(), 0)
  })
})
