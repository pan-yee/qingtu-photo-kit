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
  const previousWarn = console.warn
  const diagnostics = []
  console.warn = (...values) => diagnostics.push(values)
  let bytes = Buffer.from([255, 216, 255, 1, 2])
  let digest = ''
  let logins = 0
  let uploads = 0
  let requests = 0
  let cleanup = 0
  let denied = false
  const id = 'b'.repeat(32)
  const uploadPath = 'moderation-inbox/openid_user_123456/' + id
  config.contentSecurity = { backend: 'http', envId: 'test-env', functionName: 'contentSecurity',
    apiBaseUrl: 'https://photos.example/qingtu-api' }
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
      if (options.nativeError) { value.fail(options.nativeError); return }
      if (options.httpStatus && value.url.endsWith(options.failAt || '/session')) {
        value.success({ statusCode: options.httpStatus, header: { 'X-Request-ID': '0123456789abcdef' },
          data: { ok: false, ...(options.inputCode ? { code: options.inputCode } : {}) } }); return
      }
      if (options.badResponse && value.url.endsWith('/session')) {
        value.success({ statusCode: 200, data: '<html>unexpected page</html>' }); return
      }
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
    requests: () => requests, cleanup: () => cleanup, diagnostics }) }
  finally { global.wx = previousWx; config.contentSecurity = previousConfig; console.warn = previousWarn }
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

test('抠图传输保留已知素材拒绝码，未知服务器代码不向页面透传', async function () {
  await withHttp({ httpStatus: 422, failAt: '/jobs/matte', inputCode: 'MATTING_NO_FACE' }, async f => {
    await assert.rejects(f.transport.matte(new ArrayBuffer(8)), error => error.code === 'MATTING_NO_FACE' && error.statusCode === 422)
  })
  await withHttp({ httpStatus: 422, failAt: '/jobs/matte', inputCode: 'arbitrary-internal-code' }, async f => {
    await assert.rejects(f.transport.matte(new ArrayBuffer(8)), error => error.code === undefined && !error.message.includes('arbitrary-internal-code'))
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


test('诊断区分合法域名、TLS 和超时，不打印原始 URL、登录 code 或身份', async function () {
  for (const [message, reason] of [
    ['request:fail url not in domain list https://private.example/?token=secret', 'domain_not_allowed'],
    ['request:fail ssl certificate error user-secret', 'tls_failed'],
    ['request:fail timeout private-file.jpg', 'timeout']
  ]) {
    await withHttp({ nativeError: { errMsg: message, errCode: 600001 } }, async function (f) {
      await assert.rejects(f.client.ensureSafe('test.jpg'), function (error) {
        assert.strictEqual(error.message, '内容安全校验暂不可用，请稍后重试')
        assert.deepStrictEqual(error.diagnostic, { stage: 'session', reason, platformCode: 600001 })
        return true
      })
      const logged = JSON.stringify(f.diagnostics)
      assert(logged.includes('[content-security]'))
      for (const secret of ['private.example', 'user-secret', 'private-file', 'wx-code', 'signed-session']) assert(!logged.includes(secret))
    })
  }
})

test('HTTP 诊断保留失败阶段、状态码与受限请求号，成功 HTML 响应也不放行', async function () {
  for (const [failAt, stage] of [['/session', 'session'], ['/jobs', 'allocate'], ['/submit', 'submit']]) {
    await withHttp({ httpStatus: 503, failAt }, async function (f) {
      await assert.rejects(f.client.ensureSafe('test.jpg'), function (error) {
        assert.strictEqual(error.diagnostic.stage, stage)
        assert.strictEqual(error.diagnostic.httpStatus, 503)
        assert.strictEqual(error.diagnostic.requestId, '0123456789abcdef')
        return true
      })
    })
  }
  await withHttp({ badResponse: true }, async function (f) {
    await assert.rejects(f.client.ensureSafe('test.jpg'), function (error) {
      assert.strictEqual(error.diagnostic.reason, 'invalid_response')
      assert.strictEqual(error.diagnostic.stage, 'session')
      return true
    })
  })
})
