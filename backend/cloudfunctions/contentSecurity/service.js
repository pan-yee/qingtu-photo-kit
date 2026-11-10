const crypto = require('crypto')
const MAX_BYTES = 10 * 1024 * 1024
const JOB_TTL = 10 * 60 * 1000
const COLLECTION = 'content_security_jobs'

function imageType(buffer) {
  if (buffer.length > 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpg'
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  throw new Error('Unsupported image')
}

function createService(deps) {
  const { store, files, check, now = Date.now, randomId = () => crypto.randomBytes(16).toString('hex') } = deps

  async function cleanup(ids) {
    const targets = ids.filter(Boolean)
    if (targets.length) await files.remove(targets)
  }

  function publicJob(job) {
    return { ok: true, jobId: job.id, status: job.status,
      sha1: job.sha1 || '', expiresAt: job.expiresAt }
  }

  async function owned(id, openid) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid job')
    const job = await store.get(id)
    if (!job || job.openid !== openid) throw new Error('Invalid job owner')
    return job
  }

  async function call(event, openid) {
    if (typeof openid !== 'string' || !/^[\w-]{10,128}$/.test(openid)) throw new Error('Missing user identity')
    if (event.action === 'allocate') {
      // 服务端限流；客户端不能通过换 jobId 绕过。
      await store.rateLimit(openid, Math.floor(now() / 60000), 20)
      const id = randomId()
      const job = { id, openid, uploadPath: 'moderation-inbox/' + openid + '/' + id,
        status: 'reserved', createdAt: now(), expiresAt: now() + JOB_TTL }
      await store.add(job)
      return Object.assign(publicJob(job), { uploadPath: job.uploadPath })
    }
    const job = await owned(event.jobId, openid)
    if (job.expiresAt <= now()) {
      await store.update(job.id, { status: 'expired' })
      await cleanup([job.fileId, job.originalId])
      return publicJob(Object.assign(job, { status: 'expired' }))
    }
    if (event.action === 'status') return publicJob(job)
    if (event.action !== 'submit' || job.status !== 'reserved') throw new Error('Invalid action')
    const validUpload = typeof event.fileId === 'string' && (files.isUploadForJob
      ? files.isUploadForJob(event.fileId, job.uploadPath)
      : event.fileId.startsWith('cloud://') &&
        event.fileId.slice(event.fileId.indexOf('/', 8) + 1) === job.uploadPath)
    if (!validUpload) {
      throw new Error('Invalid upload path')
    }
    // 原子状态转换，重复提交不会重复调用 API。
    if (!await store.transition(job.id, 'reserved', { status: 'submitting', originalId: event.fileId })) {
      throw new Error('Duplicate submission')
    }
    let privateId
    try {
      const buffer = await files.read(event.fileId)
      if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_BYTES) throw new Error('Invalid image size')
      const type = imageType(buffer)
      const sha1 = crypto.createHash('sha1').update(buffer).digest('hex')
      // 校验服务端不可变副本，避免用户在异步检测期间覆盖原上传文件。
      privateId = await files.write('moderation-private/' + randomId() + '.' + type, buffer)
      const url = await files.url(privateId)
      if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error('Invalid temporary URL')
      await store.update(job.id, { fileId: privateId, sha1 })
      const response = await check({ mediaUrl: url, mediaType: 2, version: 2, scene: 2, openid })
      const traceId = response && (response.traceId || response.trace_id)
      const errcode = response && (response.errCode === undefined ? response.errcode : response.errCode)
      if (!response || errcode !== undefined && errcode !== 0 ||
          typeof traceId !== 'string' || !/^[\w-]{8,128}$/.test(traceId)) throw new Error('Audit was not accepted')
      await store.update(job.id, { status: 'pending', traceId })
      // 回调有可能早于 API 应答落库；消费已验签的短期收件箱。
      const early = await store.takeReceipt(traceId)
      if (early) await receive(early)
      const updated = await store.get(job.id)
      return publicJob(updated)
    } catch (error) {
      await store.update(job.id, { status: 'error' })
      await cleanup([privateId])
      throw new Error('Content audit unavailable')
    } finally {
      await cleanup([event.fileId])
    }
  }

  async function receive(message) {
    const job = await store.byTrace(message.trace_id)
    if (!job) {
      await store.saveReceipt(message.trace_id, { trace_id: message.trace_id, errcode: message.errcode,
        result: { suggest: message.result && message.result.suggest } }, now() + JOB_TTL)
      return
    }
    if (job.status !== 'pending') {
      await cleanup([job.fileId, job.originalId])
      return
    }
    const result = message.result || {}
    const validCode = message.errcode === 0 || message.errcode === '0'
    // 只认可显式 errcode=0 且 suggest=pass；review、未知字段和服务错误均不放行。
    const status = !validCode ? 'error'
      : result.suggest === 'pass' ? 'pass'
        : result.suggest === 'risky' || result.suggest === 'review' ? 'reject' : 'error'
    await store.transition(job.id, 'pending', { status: job.expiresAt > now() ? status : 'expired', completedAt: now() })
    await cleanup([job.fileId, job.originalId])
  }

  return { call, receive }
}

module.exports = { createService, imageType, COLLECTION }
