const express = require('express')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const { createService } = require('./cloudfunctions/contentSecurity/service')
const { readCallback } = require('./cloudfunctions/contentSecurity/callback')
const MAX_BYTES = 10 * 1024 * 1024
function unavailable(res) {
  return { ok: false, code: 'CONTENT_SECURITY_UNAVAILABLE', requestId: res.locals.requestId }
}

function createApp({ config, store, files, wechat, isReady = () => true, report = () => {} }) {
  const app = express()
  app.disable('x-powered-by')
  // 仅允许经单层 Nginx 到达；生产 Compose 端口绑定在宿主机 loopback。
  app.set('trust proxy', 1)
  const service = createService({ store, files, check: wechat.check,
    checkImmediate: config.moderationMode === 'sync' ? wechat.checkImage : undefined })
  app.use(function (req, res, next) {
    res.locals.requestId = crypto.randomBytes(8).toString('hex')
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'X-Request-ID': res.locals.requestId })
    const route = req.path === '/session' ? 'session'
      : req.path === '/wechat/callback' ? 'callback'
        : /^\/media\/[a-f0-9]{32}\.(jpg|png)$/.test(req.path) ? 'media'
        : req.path === '/jobs' ? 'allocate'
          : /^\/jobs\/[a-f0-9]{32}\/(image|submit|status)$/.test(req.path)
            ? 'job_' + req.path.split('/').pop() : null
    if (route) res.once('finish', () => report({ event: 'http', route,
      method: req.method, status: res.statusCode, requestId: res.locals.requestId }))
    next()
  })
  app.get('/health', async function (req, res) {
    try {
      if (!isReady()) throw new Error('Cleanup unavailable')
      await store.ping(); res.json({ ok: true })
    }
    catch (error) { res.status(503).json({ ok: false }) }
  })
  app.all('/wechat/callback', express.text({ type: '*/*', limit: '256kb' }), async function (req, res) {
    try {
      const result = readCallback({ httpMethod: req.method, queryStringParameters: req.query,
        body: req.body }, { appId: config.appId, token: config.callbackToken, aesKey: config.callbackAesKey })
      if (result.message) {
        const message = result.message
        report({ event: 'wechat_result', errcode: /^-?\d{1,9}$/.test(String(message.errcode))
          ? Number(message.errcode) : null,
        traceKey: crypto.createHash('sha256').update(message.trace_id).digest('hex').slice(0, 12),
        version: Number.isInteger(message.version) ? message.version : null,
        legacyStatus: Number.isInteger(message.status_code) ? message.status_code : null,
        suggest: ['pass', 'review', 'risky'].includes(message.result && message.result.suggest)
          ? message.result.suggest : 'unknown' })
        await service.receive(message)
      }
      res.type('text/plain').send(result.echo === undefined ? 'success' : result.echo)
    } catch (error) {
      const reasons = ['Invalid callback', 'Invalid encrypted callback', 'Invalid padding',
        'Invalid callback receiver', 'Invalid echo', 'Invalid method', 'Invalid body',
        'Encrypted callback required', 'Invalid audit event']
      report({ event: 'callback_rejected', reason: reasons.includes(error.message) ? error.message : 'Processing failed',
        signed: typeof req.query.signature === 'string', encrypted: typeof req.query.msg_signature === 'string',
        timestampValid: typeof req.query.timestamp === 'string' && /^\d{10}$/.test(req.query.timestamp),
        clockWithinWindow: typeof req.query.timestamp === 'string' && /^\d{10}$/.test(req.query.timestamp)
          && Math.abs(Date.now() / 1000 - Number(req.query.timestamp)) <= 300 })
      res.status(403).type('text/plain').send('invalid callback')
    }
  })
  app.get('/media/:name', async function (req, res) {
    try {
      const target = await files.signedFile(req.params.name, req.query.expires, req.query.signature)
      res.type(req.params.name.endsWith('.png') ? 'png' : 'jpg')
      res.sendFile(target, function (error) { if (error && !res.headersSent) res.status(404).end() })
    } catch (error) { res.status(404).end() }
  })
  app.post('/session', express.json({ limit: '2kb' }), async function (req, res) {
    try {
      const code = req.body && req.body.code
      if (typeof code !== 'string' || !/^[\w-]{8,256}$/.test(code)) return res.status(400).json(unavailable(res))
      await store.rateLimit('login:' + req.ip, Math.floor(Date.now() / 60000), 30)
      const openid = await wechat.login(code)
      const token = jwt.sign({ openid, appid: config.appId }, config.jwtSecret, {
        algorithm: 'HS256', expiresIn: '1h', issuer: 'qingtu-moderation', audience: 'qingtu-photo-kit'
      })
      res.json({ ok: true, token, expiresIn: 3600 })
    } catch (error) { res.status(503).json(unavailable(res)) }
  })
  app.use('/jobs', function (req, res, next) {
    if (!isReady()) return res.status(503).json(unavailable(res))
    try {
      const match = String(req.headers.authorization || '').match(/^Bearer ([\w.-]+)$/)
      if (!match) throw new Error('Missing session')
      const value = jwt.verify(match[1], config.jwtSecret, { algorithms: ['HS256'],
        issuer: 'qingtu-moderation', audience: 'qingtu-photo-kit' })
      if (value.appid !== config.appId || typeof value.openid !== 'string' || !/^[\w-]{10,128}$/.test(value.openid)) {
        throw new Error('Invalid identity')
      }
      req.openid = value.openid
      next()
    } catch (error) { res.status(401).json(unavailable(res)) }
  })
  app.post('/jobs/matte', express.raw({ type: 'application/octet-stream', limit: MAX_BYTES }), async function (req, res) {
    try {
      if (!process.env.MATTING_URL || !Buffer.isBuffer(req.body) || !req.body.length) throw new Error('Matting unavailable')
      await store.rateLimit('matte:' + req.openid, Math.floor(Date.now() / 60000), 6)
      const response = await fetch(process.env.MATTING_URL, { method: 'POST', body: req.body,
        headers: { 'Content-Type': 'application/octet-stream' }, signal: AbortSignal.timeout(45000) })
      if (response.status === 429) return res.status(429).json({ ok: false, code: 'MATTING_BUSY' })
      if (!response.ok) throw new Error('Matting unavailable')
      const result = await response.json()
      if (result.ok !== true || result.engine !== 'modnet' || typeof result.png !== 'string' || result.png.length > 2000000) throw new Error('Invalid matte')
      res.json(result)
    } catch (error) { res.status(503).json({ ok: false, code: 'MATTING_UNAVAILABLE' }) }
  })
  app.post('/jobs', express.json({ limit: '2kb' }), async function (req, res) {
    try { res.json(await service.call({ action: 'allocate' }, req.openid)) }
    catch (error) { res.status(503).json(unavailable(res)) }
  })
  async function owned(req) {
    if (!/^[a-f0-9]{32}$/.test(req.params.id)) throw new Error('Invalid task')
    const job = await store.get(req.params.id)
    if (!job || job.openid !== req.openid || job.expiresAt <= Date.now()) throw new Error('Invalid task')
    return job
  }
  app.post('/jobs/:id/image', express.raw({ type: 'application/octet-stream', limit: MAX_BYTES }), async function (req, res) {
    try {
      const job = await owned(req)
      if (job.status !== 'reserved' || !Buffer.isBuffer(req.body) || !req.body.length || req.body.length > MAX_BYTES) {
        throw new Error('Invalid upload')
      }
      await files.upload(job.uploadPath, req.body)
      res.json({ ok: true, fileId: job.uploadPath })
    } catch (error) { res.status(400).json(unavailable(res)) }
  })
  app.delete('/jobs/:id/image', async function (req, res) {
    try { const job = await owned(req); await files.remove([job.uploadPath]); res.json({ ok: true }) }
    catch (error) { res.status(400).json(unavailable(res)) }
  })
  app.post('/jobs/:id/submit', express.json({ limit: '2kb' }), async function (req, res) {
    try {
      res.json(await service.call({ action: 'submit', jobId: req.params.id,
        fileId: req.body && req.body.fileId }, req.openid))
    } catch (error) { res.status(503).json(unavailable(res)) }
  })
  app.get('/jobs/:id/status', async function (req, res) {
    try { res.json(await service.call({ action: 'status', jobId: req.params.id }, req.openid)) }
    catch (error) { res.status(503).json(unavailable(res)) }
  })
  app.use(function (req, res) { res.status(404).json(unavailable(res)) })
  app.use(function (error, req, res, next) {
    if (!res.headersSent) res.status(error.type === 'entity.too.large' ? 413 : 400).json(unavailable(res))
    else next(error)
  })
  return app
}
module.exports = { createApp }
