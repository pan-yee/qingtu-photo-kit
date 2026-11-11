const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { assert, test } = require('./harness')
const { createApp } = require('../app')
const { createFiles } = require('../files')
const { createWechat } = require('../wechat')
const { configuration } = require('../index')

function fixture() {
  const jobs = new Map()
  const receipts = new Map()
  const limits = new Map()
  return {
    jobs,
    async ping() {}, async prune() {},
    async add(job) { jobs.set(job.id, { ...job }) },
    async get(id) { return jobs.get(id) },
    async update(id, patch) { Object.assign(jobs.get(id), patch) },
    async transition(id, previous, patch) {
      if (jobs.get(id).status !== previous) return false
      Object.assign(jobs.get(id), patch); return true
    },
    async byTrace(trace) { return Array.from(jobs.values()).find(value => value.traceId === trace) },
    async saveReceipt(trace, message) { receipts.set(trace, message) },
    async takeReceipt(trace) { const value = receipts.get(trace); receipts.delete(trace); return value },
    async rateLimit(identity, window, limit) {
      const key = identity + ':' + window
      const count = (limits.get(key) || 0) + 1; limits.set(key, count)
      if (count > limit) throw new Error('Limited')
    }
  }
}

test('高清抠图需要登录、限制每用户次数，服务错误不输出图片结果', async function () {
  const http = require('http')
  const previous = process.env.MATTING_URL
  let calls = 0
  let busy = false
  const worker = http.createServer((req, res) => {
    calls += 1; req.resume()
    res.setHeader('Content-Type', 'application/json')
    if (busy) { res.statusCode = 429; return res.end(JSON.stringify({ ok: false })) }
    res.end(JSON.stringify({ ok: true, engine: 'modnet', width: 32, height: 32, png: 'test-mask' }))
  }).listen(0, '127.0.0.1')
  await new Promise(resolve => worker.once('listening', resolve))
  process.env.MATTING_URL = 'http://127.0.0.1:' + worker.address().port + '/matte'
  try {
    await withServer(async ({ call, login }) => {
      assert.strictEqual((await call('/jobs/matte', 'POST', Buffer.from('image'))).status, 401)
      assert.strictEqual(calls, 0)
      const token = await login()
      for (let i = 0; i < 6; i += 1) {
        const response = await call('/jobs/matte', 'POST', Buffer.from('image'), token)
        assert.strictEqual(response.status, 200)
        assert.strictEqual((await response.json()).engine, 'modnet')
      }
      assert.strictEqual((await call('/jobs/matte', 'POST', Buffer.from('image'), token)).status, 503)
      assert.strictEqual(calls, 6)
      delete process.env.MATTING_URL
      const response = await call('/jobs/matte', 'POST', Buffer.from('image'), token)
      assert.deepStrictEqual(await response.json(), { ok: false, code: 'MATTING_UNAVAILABLE' })
    })
    process.env.MATTING_URL = 'http://127.0.0.1:' + worker.address().port + '/matte'
    busy = true
    await withServer(async ({ call, login }) => {
      const response = await call('/jobs/matte', 'POST', Buffer.from('image'), await login())
      assert.strictEqual(response.status, 429)
      assert.deepStrictEqual(await response.json(), { ok: false, code: 'MATTING_BUSY' })
    })
  } finally {
    if (previous === undefined) delete process.env.MATTING_URL
    else process.env.MATTING_URL = previous
    worker.closeAllConnections(); await new Promise(resolve => worker.close(resolve))
  }
})
async function withServer(body, isReady, moderationMode = 'async', syncCheck = async () => ({ errcode: 0 })) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qingtu-server-test-'))
  const config = { dataDir, appId: 'wx2b68d0818781b66d', jwtSecret: 'j'.repeat(40),
    mediaSecret: 'm'.repeat(40), callbackToken: 'callbackToken', callbackAesKey: Buffer.alloc(32, 1).toString('base64').slice(0, 43),
    publicBaseUrl: 'https://photos.example/qingtu-api', moderationMode }
  const store = fixture()
  const reports = []
  const files = await createFiles(config)
  let apiCalls = 0
  let mediaUrl
  const app = createApp({ config, store, files, isReady, report: entry => reports.push(entry), wechat: {
    login: async code => code === 'second-user-code' ? 'openid_second_user' : 'openid_first_user',
    checkImage: syncCheck,
    check: async input => { apiCalls += 1; mediaUrl = input.mediaUrl; return { errcode: 0, trace_id: 'trace_id_12345678' } }
  } })
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  async function call(route, method = 'GET', body, token) {
    const binary = Buffer.isBuffer(body)
    return fetch(base + route, { method, headers: {
      'Content-Type': binary ? 'application/octet-stream' : 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : binary ? body : JSON.stringify(body) })
  }
  async function login(code = 'first-user-code') { return (await (await call('/session', 'POST', { code })).json()).token }
  try { await body({ call, login, config, store, files, apiCalls: () => apiCalls,
    mediaUrl: () => mediaUrl, base, reports }) } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    assert.strictEqual(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()))
    assert(path.basename(dataDir).startsWith('qingtu-server-test-'))
    for (const file of await fs.readdir(dataDir)) await fs.unlink(path.join(dataDir, file))
    await fs.rmdir(dataDir)
  }
}
function encryptedCallback(config, message) {
  const text = Buffer.from(JSON.stringify(message))
  const payload = Buffer.alloc(20 + text.length + Buffer.byteLength(config.appId))
  payload.writeUInt32BE(text.length, 16); text.copy(payload, 20); payload.write(config.appId, 20 + text.length)
  const pad = 32 - payload.length % 32
  const key = Buffer.from(config.callbackAesKey + '=', 'base64')
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.alloc(pad, pad)])), cipher.final()]).toString('base64')
  const timestamp = String(Math.floor(Date.now() / 1000)); const nonce = 'test-nonce'
  const signature = crypto.createHash('sha1').update([config.callbackToken, timestamp, nonce, encrypted].sort().join('')).digest('hex')
  return { route: '/wechat/callback?timestamp=' + timestamp + '&nonce=' + nonce + '&msg_signature=' + signature,
    body: { Encrypt: encrypted } }
}

test('审核诊断仅记录固定路由和状态，不泄露查询、请求体或登录凭据', async function () {
  await withServer(async function (f) {
    const secret = 'sensitive-marker-do-not-log'
    await f.call('/wechat/callback?signature=' + secret + '&timestamp=bad&nonce=' + secret,
      'POST', { Encrypt: secret, token: secret })
    await f.login()
    const logged = JSON.stringify(f.reports)
    assert(!logged.includes(secret))
    assert(!logged.includes('first-user-code'))
    assert(!logged.includes('openid_first_user'))
    assert(f.reports.some(entry => entry.event === 'callback_rejected'))
    assert(f.reports.some(entry => entry.route === 'callback' && entry.status === 403))
    assert(f.reports.some(entry => entry.route === 'session' && entry.status === 200))
  })
})

test('自有后端端到端：JWT 身份、真实字节上传、pending、可信加密回调及文件清理', async function () {
  await withServer(async function (f) {
    assert.strictEqual((await f.call('/health')).status, 200)
    assert.strictEqual((await f.call('/jobs', 'POST', {})).status, 401)
    const token = await f.login()
    const job = await (await f.call('/jobs', 'POST', {}, token)).json()
    const bytes = Buffer.from([255, 216, 255, 1, 2, 3])
    const upload = await (await f.call('/jobs/' + job.jobId + '/image', 'POST', bytes, token)).json()
    assert.strictEqual(upload.fileId, job.uploadPath)
    const submitted = await (await f.call('/jobs/' + job.jobId + '/submit', 'POST', { fileId: upload.fileId }, token)).json()
    assert.strictEqual(submitted.status, 'pending')
    assert.strictEqual(submitted.sha1, crypto.createHash('sha1').update(bytes).digest('hex'))
    assert.strictEqual(f.apiCalls(), 1)
    const media = new URL(f.mediaUrl())
    const mediaRoute = media.pathname.replace('/qingtu-api', '') + media.search
    assert.deepStrictEqual(Buffer.from(await (await f.call(mediaRoute)).arrayBuffer()), bytes)
    const forged = await f.call('/wechat/callback', 'POST', { status: 'pass', trace_id: 'trace_id_12345678' })
    assert.strictEqual(forged.status, 403)
    const callback = encryptedCallback(f.config, { MsgType: 'event', Event: 'wxa_media_check',
      trace_id: 'trace_id_12345678', errcode: 0, result: { suggest: 'pass' } })
    assert.strictEqual((await f.call(callback.route, 'POST', callback.body)).status, 200)
    const status = await (await f.call('/jobs/' + job.jobId + '/status', 'GET', undefined, token)).json()
    assert.strictEqual(status.status, 'pass')
    assert.strictEqual((await f.call(mediaRoute)).status, 404)
    assert.strictEqual((await f.call('/jobs/' + job.jobId + '/submit', 'POST', { fileId: upload.fileId }, token)).status, 503)
    assert.strictEqual(f.apiCalls(), 1)
  })
})
test('自有后端拒绝越权、重复上传、签名篡改、超大图片及过期任务', async function () {
  await withServer(async function (f) {
    const token = await f.login(); const second = await f.login('second-user-code')
    const job = await (await f.call('/jobs', 'POST', {}, token)).json()
    const route = '/jobs/' + job.jobId
    const bytes = Buffer.from([255, 216, 255, 1])
    assert.strictEqual((await f.call(route + '/status', 'GET', undefined, second)).status, 503)
    assert.strictEqual((await f.call(route + '/image', 'POST', bytes, second)).status, 400)
    assert.strictEqual((await f.call(route + '/image', 'POST', bytes, token)).status, 200)
    assert.strictEqual((await f.call(route + '/image', 'POST', bytes, token)).status, 400)
    assert.strictEqual((await f.call(route + '/image', 'POST', Buffer.alloc(10 * 1024 * 1024 + 1), token)).status, 413)
    await f.call(route + '/submit', 'POST', { fileId: job.uploadPath }, token)
    const media = new URL(f.mediaUrl())
    assert.strictEqual((await f.call(media.pathname.replace('/qingtu-api', '') + '?expires=' + media.searchParams.get('expires') + '&signature=' + '0'.repeat(64))).status, 404)
    f.store.jobs.get(job.jobId).expiresAt = Date.now() - 1
    const expired = await (await f.call(route + '/status', 'GET', undefined, token)).json()
    assert.strictEqual(expired.status, 'expired')
  })
})
test('自有后端在回调丢失时按 TTL 独立清理图片，拒绝路径穿越', async function () {
  await withServer(async function (f) {
    const id = 'moderation-private/' + 'a'.repeat(32) + '.jpg'
    await f.files.write(id, Buffer.from([255, 216, 255, 1]))
    await assert.rejects(f.files.read('../../outside'))
    await f.files.prune(Date.now() + 11 * 60000)
    await assert.rejects(f.files.read(id), { code: 'ENOENT' })
  })
})
test('自有后端限流阻止第 21 个图片任务', async function () {
  await withServer(async function (f) {
    const token = await f.login()
    for (let n = 0; n < 20; n += 1) assert.strictEqual((await f.call('/jobs', 'POST', {}, token)).status, 200)
    assert.strictEqual((await f.call('/jobs', 'POST', {}, token)).status, 503)
  })
})

test('同步 HTTP 审核提交直接返回可信最终状态，无需回调且不保留上传', async function () {
  for (const [code, status] of [[0, 'pass'], [87014, 'reject']]) {
    await withServer(async function (f) {
      const token = await f.login()
      const job = await (await f.call('/jobs', 'POST', {}, token)).json()
      const bytes = Buffer.from([255, 216, 255, 1, 2, 3])
      await f.call('/jobs/' + job.jobId + '/image', 'POST', bytes, token)
      const response = await f.call('/jobs/' + job.jobId + '/submit', 'POST',
        { fileId: job.uploadPath, status: 'pass' }, token)
      const value = await response.json()
      assert.strictEqual(response.status, 200)
      assert.strictEqual(value.status, status)
      assert.strictEqual(value.sha1, crypto.createHash('sha1').update(bytes).digest('hex'))
      assert.strictEqual(f.apiCalls(), 0)
      await assert.rejects(f.files.read(job.uploadPath), { code: 'ENOENT' })
    }, undefined, 'sync', async () => ({ errcode: code }))
  }
})

test('同步图片适配器上传 JPEG 检测副本，失效 token 仅刷新重试一次', async function () {
  let tokens = 0; let calls = 0; let preparations = 0
  const report = []
  const wechat = createWechat({ appId: 'wx2b68d0818781b66d', appSecret: 'test-secret' }, async (url, options) => {
    if (String(url).includes('stable_token')) {
      tokens += 1
      return { ok: true, json: async () => ({ access_token: 'test-token-' + tokens, expires_in: 7200 }) }
    }
    calls += 1
    assert(String(url).includes('/wxa/img_sec_check?'))
    assert(options.body instanceof FormData)
    const image = options.body.get('media')
    assert.strictEqual(image.type, 'image/jpeg')
    assert.deepStrictEqual(Buffer.from(await image.arrayBuffer()), Buffer.from('server-audit-copy'))
    return { ok: true, json: async () => ({ errcode: calls === 1 ? 40001 : 0 }) }
  }, entry => report.push(entry), async bytes => {
    preparations += 1; assert.strictEqual(bytes.toString(), 'original')
    return Buffer.from('server-audit-copy')
  })
  assert.strictEqual((await wechat.checkImage(Buffer.from('original'))).errcode, 0)
  assert.strictEqual(tokens, 2); assert.strictEqual(calls, 2); assert.strictEqual(preparations, 1)
  assert(!JSON.stringify(report).includes('test-token'))
})

test('检测副本保留完整画面并限制尺寸体积，拒绝损坏图片', async function () {
  const sharp = require('sharp')
  const { prepareAuditImage } = require('../audit-image')
  const original = await sharp({ create: { width: 1800, height: 2400, channels: 4,
    background: { r: 40, g: 120, b: 80, alpha: 0.7 } } }).png().toBuffer()
  const copy = await prepareAuditImage(original)
  const metadata = await sharp(copy).metadata()
  assert.strictEqual(metadata.format, 'jpeg')
  assert(metadata.width <= 750 && metadata.height <= 1334)
  assert(Math.abs(metadata.width / metadata.height - 1800 / 2400) < 0.002)
  assert.strictEqual(metadata.hasAlpha, false)
  assert(copy.length < 1024 * 1024)
  await assert.rejects(prepareAuditImage(Buffer.from([255, 216, 255, 1, 2])))
})
test('自有后端清理异常时健康检查失败并暂停新任务', async function () {
  await withServer(async function (f) {
    assert.strictEqual((await f.call('/health')).status, 503)
    const token = await f.login()
    assert.strictEqual((await f.call('/jobs', 'POST', {}, token)).status, 503)
    assert.strictEqual(f.store.jobs.size, 0)
  }, () => false)
})
test('微信 HTTP 适配器使用图片接口，缓存 token，并对失效 token 只重试一次', async function () {
  let tokenCalls = 0; let auditCalls = 0
  const wechat = createWechat({ appId: 'wx2b68d0818781b66d', appSecret: 'server-only-secret' }, async function (url, options) {
    if (String(url).includes('stable_token')) {
      tokenCalls += 1
      assert.strictEqual(JSON.parse(options.body).secret, 'server-only-secret')
      return { ok: true, json: async () => ({ access_token: 'test-access-token', expires_in: 7200 }) }
    }
    auditCalls += 1
    assert(String(url).includes('/wxa/media_check_async?'))
    assert.deepStrictEqual(JSON.parse(options.body), { media_url: 'https://photos.example/image', media_type: 2,
      version: 2, scene: 2, openid: 'openid_first_user' })
    return { ok: true, json: async () => auditCalls === 1 ? { errcode: 40001 } : { errcode: 0, trace_id: 'trace_id_12345678' } }
  })
  const input = { mediaUrl: 'https://photos.example/image', openid: 'openid_first_user' }
  assert.strictEqual((await wechat.check(input)).errcode, 0)
  await wechat.check(input)
  assert.strictEqual(tokenCalls, 2); assert.strictEqual(auditCalls, 3)
})
test('自有后端启动拒绝缺失密钥、共用签名密钥和非 HTTPS 外部地址', function () {
  const env = { WX_APPID: 'wx2b68d0818781b66d', WX_SECRET: 'server-only-secret', JWT_SECRET: 'j'.repeat(40),
    MEDIA_SIGNING_SECRET: 'm'.repeat(40), CONTENT_SECURITY_CALLBACK_TOKEN: 'callbackToken',
    CONTENT_SECURITY_CALLBACK_AES_KEY: Buffer.alloc(32, 1).toString('base64').slice(0, 43), PUBLIC_BASE_URL: 'https://photos.example/qingtu-api' }
  assert.strictEqual(configuration(env).appId, env.WX_APPID)
  for (const patch of [{ WX_SECRET: '' }, { JWT_SECRET: 'short' }, { MEDIA_SIGNING_SECRET: env.JWT_SECRET },
    { PUBLIC_BASE_URL: 'http://photos.example' }, { CONTENT_SECURITY_CALLBACK_AES_KEY: '' }]) {
    assert.throws(() => configuration({ ...env, ...patch }))
  }
})

test('服务错误返回可关联的随机请求号，不返回身份或异常详情', async function () {
  await withServer(async function (f) {
    const response = await f.call('/jobs', 'POST', {})
    const body = await response.json()
    const id = response.headers.get('x-request-id')
    assert.strictEqual(response.status, 401)
    assert.match(id, /^[a-f0-9]{16}$/)
    assert.strictEqual(body.requestId, id)
    assert.strictEqual(body.code, 'CONTENT_SECURITY_UNAVAILABLE')
    assert(f.reports.some(entry => entry.requestId === id && entry.route === 'allocate'))
    assert(!JSON.stringify(body).includes('openid'))
    const next = await f.call('/jobs', 'POST', {})
    assert.notStrictEqual(next.headers.get('x-request-id'), id)
  })
})
