const crypto = require('crypto')
const { assert, test } = require('./harness')
const { createService } = require('../cloudfunctions/contentSecurity/service')
const { readCallback } = require('../cloudfunctions/contentSecurity/callback')

function fixture(checkOverride, checkImmediate) {
  const rows = new Map()
  const receipts = new Map()
  const data = new Map()
  const removed = []
  let count = 0
  let apiCalls = 0
  let currentTime = 1700000000000
  const store = {
    async add(row) { rows.set(row.id, Object.assign({}, row)) },
    async get(id) { return rows.get(id) },
    async update(id, patch) { Object.assign(rows.get(id), patch) },
    async transition(id, state, patch) {
      const row = rows.get(id)
      if (row.status !== state) return false
      Object.assign(row, patch)
      return true
    },
    async byTrace(trace) { return Array.from(rows.values()).find(row => row.traceId === trace) },
    async saveReceipt(trace, message) { receipts.set(trace, message) },
    async takeReceipt(trace) { const value = receipts.get(trace); receipts.delete(trace); return value },
    async rateLimit() { if (++count > 20) throw new Error('rate limit') }
  }
  const files = {
    async read(id) { return data.get(id) },
    async write(path, buffer) { const id = 'cloud://test.bucket/' + path; data.set(id, Buffer.from(buffer)); return id },
    async url(id) { return 'https://storage.example/' + encodeURIComponent(id) },
    async remove(ids) { removed.push(...ids); ids.forEach(id => data.delete(id)) }
  }
  let random = 0
  const service = createService({ store, files, checkImmediate,
    now: () => currentTime, randomId: () => (++random).toString(16).padStart(32, '0'),
    check: async function (input) {
      apiCalls += 1
      assert.strictEqual(input.openid, 'openid_user_123456')
      assert.strictEqual(input.version, 2)
      assert.strictEqual(input.mediaType, 2)
      return checkOverride ? checkOverride(input, service) : { errCode: 0, traceId: 'trace_id_1234567890' }
    }
  })
  async function allocate() {
    const job = await service.call({ action: 'allocate' }, 'openid_user_123456')
    const fileId = 'cloud://test.bucket/' + job.uploadPath
    data.set(fileId, Buffer.from([255, 216, 255, 0, 10, 20, 30]))
    return Object.assign(job, { fileId })
  }
  return { service, allocate, rows, data, removed, apiCalls: () => apiCalls,
    expire: () => { currentTime += 11 * 60000 } }
}

function result(suggest, extra) {
  return Object.assign({ trace_id: 'trace_id_1234567890', errcode: 0, result: { suggest } }, extra)
}

test('图片异步接口受理后保持 pending，只有可信 pass 才放行并删除临时图片', async function () {
  const f = fixture()
  const job = await f.allocate()
  const response = await f.service.call({ action: 'submit', jobId: job.jobId, fileId: job.fileId,
    openid: 'forged-user', status: 'pass' }, 'openid_user_123456')
  assert.strictEqual(response.status, 'pending')
  assert.match(response.sha1, /^[a-f0-9]{40}$/)
  assert.strictEqual(f.apiCalls(), 1)
  const stored = f.rows.get(job.jobId)
  const privateId = stored.fileId
  assert(privateId.includes('moderation-private/'))
  assert(f.removed.includes(job.fileId))
  await f.service.receive(result('pass'))
  assert.strictEqual((await f.service.call({ action: 'status', jobId: job.jobId }, 'openid_user_123456')).status, 'pass')
  assert(f.removed.includes(privateId))
})

test('同步审核仅凭服务器检测结果放行或拒绝，绑定原图摘要并清理上传', async function () {
  for (const [code, status] of [[0, 'pass'], [87014, 'reject']]) {
    const f = fixture(undefined, async bytes => {
      assert(Buffer.isBuffer(bytes))
      return { errcode: code }
    })
    const job = await f.allocate()
    const digest = crypto.createHash('sha1').update(f.data.get(job.fileId)).digest('hex')
    const response = await f.service.call({ action: 'submit', jobId: job.jobId, fileId: job.fileId,
      status: 'pass' }, 'openid_user_123456')
    assert.strictEqual(response.status, status)
    assert.strictEqual(response.sha1, digest)
    assert.strictEqual(f.apiCalls(), 0)
    assert.strictEqual(f.data.size, 0)
    assert.strictEqual(f.rows.get(job.jobId).traceId, undefined)
  }
})

test('同步接口未知、错误、缺失或字符串成功码均不放行，过期结果不放行', async function () {
  for (const code of [undefined, null, '0', 40001, -1]) {
    const f = fixture(undefined, async () => ({ errcode: code }))
    const job = await f.allocate()
    await assert.rejects(f.service.call({ action: 'submit', jobId: job.jobId, fileId: job.fileId },
      'openid_user_123456'), /unavailable/)
    assert.strictEqual(f.rows.get(job.jobId).status, 'error')
    assert.strictEqual(f.data.size, 0)
  }
  const f = fixture(undefined, async () => { f.expire(); return { errcode: 0 } })
  const job = await f.allocate()
  assert.strictEqual((await f.service.call({ action: 'submit', jobId: job.jobId, fileId: job.fileId },
    'openid_user_123456')).status, 'expired')
})

test('review、risky、未知结果及缺少错误码都不会通过', async function () {
  for (const [suggest, extra, expected] of [
    ['review', {}, 'reject'], ['risky', {}, 'reject'], ['unknown', {}, 'error'],
    ['pass', { errcode: undefined }, 'error'], ['pass', { errcode: null }, 'error'],
    ['pass', { errcode: 87014 }, 'error']
  ]) {
    const f = fixture(); const job = await f.allocate()
    await f.service.call({ action: 'submit', jobId: job.jobId, fileId: job.fileId }, 'openid_user_123456')
    await f.service.receive(result(suggest, extra))
    assert.strictEqual(f.rows.get(job.jobId).status, expected)
  }
})

test('不能查询他人任务、伪造回调动作、替换上传路径或重复提交', async function () {
  const f = fixture(); const job = await f.allocate()
  await assert.rejects(f.service.call({ action: 'status', jobId: job.jobId }, 'different_user_123'), /owner/)
  await assert.rejects(f.service.call({ action: 'callback', jobId: job.jobId, status: 'pass' }, 'openid_user_123456'), /action/)
  await assert.rejects(f.service.call({ action: 'submit', jobId: job.jobId, fileId: 'cloud://test.bucket/another-user/image' }, 'openid_user_123456'), /path/)
  assert.strictEqual(f.apiCalls(), 0)
  await f.service.call({ action: 'submit', jobId: job.jobId, fileId: job.fileId }, 'openid_user_123456')
  await assert.rejects(f.service.call({ action: 'submit', jobId: job.jobId, fileId: job.fileId }, 'openid_user_123456'), /action/)
  assert.strictEqual(f.apiCalls(), 1)
})

test('可信回调服务错误保留数字诊断码，但不放行或向客户端暴露内部字段', async function () {
  const f = fixture(); const job = await f.allocate()
  await f.service.call({ action: 'submit', jobId: job.jobId, fileId: job.fileId }, 'openid_user_123456')
  await f.service.receive(result('pass', { errcode: -1008 }))
  assert.strictEqual(f.rows.get(job.jobId).auditErrcode, -1008)
  const response = await f.service.call({ action: 'status', jobId: job.jobId }, 'openid_user_123456')
  assert.strictEqual(response.status, 'error')
  assert.strictEqual(response.auditErrcode, undefined)
  assert.strictEqual(response.auditSuggest, undefined)
})

test('回调先于 API 应答落库时不会丢失；过期结果仍不放行', async function () {
  const f = fixture(async function (input, service) {
    await service.receive(result('pass'))
    return { traceId: 'trace_id_1234567890' }
  })
  const job = await f.allocate()
  assert.strictEqual((await f.service.call({ action: 'submit', jobId: job.jobId, fileId: job.fileId }, 'openid_user_123456')).status, 'pass')
  f.expire()
  assert.strictEqual((await f.service.call({ action: 'status', jobId: job.jobId }, 'openid_user_123456')).status, 'expired')
})

test('不支持的文件和 API 失败不会形成通过记录', async function () {
  const f = fixture(); const job = await f.allocate()
  f.data.set(job.fileId, Buffer.from('not an image'))
  await assert.rejects(f.service.call({ action: 'submit', jobId: job.jobId, fileId: job.fileId }, 'openid_user_123456'), /unavailable/)
  assert.strictEqual(f.apiCalls(), 0)
  assert.strictEqual(f.rows.get(job.jobId).status, 'error')
  const bad = fixture(async () => ({ errCode: 40001 }))
  const second = await bad.allocate()
  await assert.rejects(bad.service.call({ action: 'submit', jobId: second.jobId, fileId: second.fileId }, 'openid_user_123456'), /unavailable/)
  assert.strictEqual(bad.rows.get(second.jobId).status, 'error')
})

function signedMessage(overrides) {
  const key = crypto.randomBytes(32)
  const token = crypto.randomBytes(20).toString('hex')
  const appId = 'wx2b68d0818781b66d'
  const message = Object.assign({ MsgType: 'event', Event: 'wxa_media_check', appid: appId }, result('pass'), overrides)
  const text = Buffer.from(JSON.stringify(message))
  const size = Buffer.alloc(4); size.writeUInt32BE(text.length)
  const body = Buffer.concat([crypto.randomBytes(16), size, text, Buffer.from(appId)])
  const pad = 32 - body.length % 32
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([body, Buffer.alloc(pad, pad)])), cipher.final()]).toString('base64')
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = crypto.randomBytes(8).toString('hex')
  const msgSignature = crypto.createHash('sha1').update([token, timestamp, nonce, encrypted].sort().join('')).digest('hex')
  return {
    event: { httpMethod: 'POST', queryStringParameters: { timestamp, nonce, msg_signature: msgSignature },
      body: JSON.stringify({ Encrypt: encrypted }) },
    options: { token, aesKey: key.toString('base64').replace(/=$/, ''), appId }
  }
}

test('微信安全回调必须验签解密，拒绝伪造、错误 AppID、旧时间戳和明文', function () {
  const f = signedMessage()
  assert.strictEqual(readCallback(f.event, f.options).message.result.suggest, 'pass')
  const forged = Object.assign({}, f.event, { body: JSON.stringify(result('pass')) })
  assert.throws(() => readCallback(forged, f.options), /Encrypted/)
  assert.throws(() => readCallback(f.event, Object.assign({}, f.options, { token: 'wrong' })), /Invalid/)
  assert.throws(() => readCallback(f.event, Object.assign({}, f.options, { appId: 'another-app' })), /receiver/)
  assert.throws(() => readCallback(f.event, Object.assign({}, f.options, { now: Date.now() + 600000 })), /Invalid/)
  const other = signedMessage({ Event: 'different_event' })
  assert.throws(() => readCallback(other.event, other.options), /Invalid/)
})

test('v2 加密回调缺少顶层错误码时，仅完整成功明细和明确 pass 可兼容', function () {
  const detail = [{ errcode: 0, suggest: 'pass' }]
  const valid = signedMessage({ errcode: undefined, version: 2, detail })
  assert.strictEqual(readCallback(valid.event, valid.options).message.errcode, 0)
  for (const changes of [
    { detail: [] }, { detail: [{ suggest: 'pass' }] },
    { detail: [{ errcode: -1008, suggest: 'pass' }] },
    { detail: [{ errcode: 0, suggest: 'review' }] },
    { detail: [null] }, { version: 1 }, { errcode: null }, { errcode: -1008 },
    { result: { suggest: 'unknown' } }
  ]) {
    const f = signedMessage({ errcode: undefined, version: 2, detail, ...changes })
    assert.notStrictEqual(readCallback(f.event, f.options).message.errcode, 0)
  }
  const forged = signedMessage({ errcode: undefined, version: 2, detail: [] })
  const wrapper = JSON.parse(forged.event.body)
  wrapper.errcode = 0; wrapper.detail = detail; wrapper.result = { suggest: 'pass' }
  forged.event.body = JSON.stringify(wrapper)
  assert.strictEqual(readCallback(forged.event, forged.options).message.errcode, undefined)
})


test('微信加密 XML 包装可验证，GET URL challenge 支持普通和加密签名', function () {
  const f = signedMessage()
  const encrypted = JSON.parse(f.event.body).Encrypt
  const xml = Object.assign({}, f.event, { body: '<xml><Encrypt><![CDATA[' + encrypted + ']]></Encrypt></xml>' })
  assert.strictEqual(readCallback(xml, f.options).message.trace_id, 'trace_id_1234567890')
  const query = Object.assign({}, f.event.queryStringParameters)
  query.echostr = encrypted
  assert(readCallback({ httpMethod: 'GET', queryStringParameters: query }, f.options).echo.includes('wxa_media_check'))
  delete query.msg_signature
  query.echostr = 'url-verification-challenge'
  query.signature = crypto.createHash('sha1').update([f.options.token, query.timestamp, query.nonce].sort().join('')).digest('hex')
  assert.strictEqual(readCallback({ httpMethod: 'GET', queryStringParameters: query }, f.options).echo, query.echostr)
})

test('并发重复提交只调用一次图片安全 API，服务端限流不会接受第 21 个任务', async function () {
  const f = fixture(); const job = await f.allocate()
  const event = { action: 'submit', jobId: job.jobId, fileId: job.fileId }
  const results = await Promise.allSettled([
    f.service.call(event, 'openid_user_123456'), f.service.call(event, 'openid_user_123456')
  ])
  assert.strictEqual(results.filter(item => item.status === 'fulfilled').length, 1)
  assert.strictEqual(f.apiCalls(), 1)
  const limited = fixture()
  for (let i = 0; i < 20; i += 1) await limited.allocate()
  await assert.rejects(limited.allocate(), /rate limit/)
})
