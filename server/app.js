const express = require('express')
const jwt = require('jsonwebtoken')
const { createService } = require('../cloudfunctions/contentSecurity/service')
const { readCallback } = require('../cloudfunctions/contentSecurity/callback')
const MAX_BYTES = 10 * 1024 * 1024
const unavailable = { ok: false, code: 'CONTENT_SECURITY_UNAVAILABLE' }

function createApp({ config, store, files, wechat, isReady = () => true }) {
  const app = express()
  app.disable('x-powered-by')
  // 仅允许经单层 Nginx 到达；生产 Compose 端口绑定在宿主机 loopback。
  app.set('trust proxy', 1)
  const service = createService({ store, files, check: wechat.check })
  app.use(function (req, res, next) {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
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
      if (result.message) await service.receive(result.message)
      res.type('text/plain').send(result.echo === undefined ? 'success' : result.echo)
    } catch (error) { res.status(403).type('text/plain').send('invalid callback') }
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
      if (typeof code !== 'string' || !/^[\w-]{8,256}$/.test(code)) return res.status(400).json(unavailable)
      await store.rateLimit('login:' + req.ip, Math.floor(Date.now() / 60000), 30)
      const openid = await wechat.login(code)
      const token = jwt.sign({ openid, appid: config.appId }, config.jwtSecret, {
        algorithm: 'HS256', expiresIn: '1h', issuer: 'qingtu-moderation', audience: 'qingtu-photo-kit'
      })
      res.json({ ok: true, token, expiresIn: 3600 })
    } catch (error) { res.status(503).json(unavailable) }
  })
  app.use('/jobs', function (req, res, next) {
    if (!isReady()) return res.status(503).json(unavailable)
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
    } catch (error) { res.status(401).json(unavailable) }
  })
  app.post('/jobs', express.json({ limit: '2kb' }), async function (req, res) {
    try { res.json(await service.call({ action: 'allocate' }, req.openid)) }
    catch (error) { res.status(503).json(unavailable) }
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
    } catch (error) { res.status(400).json(unavailable) }
  })
  app.delete('/jobs/:id/image', async function (req, res) {
    try { const job = await owned(req); await files.remove([job.uploadPath]); res.json({ ok: true }) }
    catch (error) { res.status(400).json(unavailable) }
  })
  app.post('/jobs/:id/submit', express.json({ limit: '2kb' }), async function (req, res) {
    try {
      res.json(await service.call({ action: 'submit', jobId: req.params.id,
        fileId: req.body && req.body.fileId }, req.openid))
    } catch (error) { res.status(503).json(unavailable) }
  })
  app.get('/jobs/:id/status', async function (req, res) {
    try { res.json(await service.call({ action: 'status', jobId: req.params.id }, req.openid)) }
    catch (error) { res.status(503).json(unavailable) }
  })
  app.use(function (req, res) { res.status(404).json(unavailable) })
  app.use(function (error, req, res, next) {
    if (!res.headersSent) res.status(error.type === 'entity.too.large' ? 413 : 400).json(unavailable)
    else next(error)
  })
  return app
}
module.exports = { createApp }
