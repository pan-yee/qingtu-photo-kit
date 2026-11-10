// Real public HTTP + real WeChat API smoke test, using an isolated synthetic identity/image.
const assert = require('assert')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const sharp = require('sharp')
const mysql = require('mysql2/promise')
const { configuration } = require('../index')
const { createFiles } = require('../files')
async function main() {
  const started = Date.now()
  const config = configuration(process.env)
  assert.strictEqual(config.moderationMode, 'sync')
  const identity = 'openid_smoke_' + crypto.randomBytes(12).toString('hex')
  const token = jwt.sign({ openid: identity, appid: config.appId }, config.jwtSecret, {
    algorithm: 'HS256', expiresIn: '2m', issuer: 'qingtu-moderation', audience: 'qingtu-photo-kit' })
  const bytes = await sharp({ create: { width: 1600, height: 1800, channels: 3,
    background: '#379169' } }).png().toBuffer()
  async function call(path, method, body, binary) {
    const response = await fetch(config.publicBaseUrl + path, { method,
      headers: { Authorization: 'Bearer ' + token,
        'Content-Type': binary ? 'application/octet-stream' : 'application/json' },
      body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(55000), redirect: 'error' })
    assert.strictEqual(response.status, 200)
    const value = await response.json(); assert.strictEqual(value.ok, true)
    return value
  }
  const pool = mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME })
  let job
  try {
    job = await call('/jobs', 'POST', {})
    const route = '/jobs/' + job.jobId
    const uploaded = await call(route + '/image', 'POST', bytes, true)
    const result = await call(route + '/submit', 'POST', { fileId: uploaded.fileId })
    assert.strictEqual(result.status, 'pass')
    assert.strictEqual(result.sha1, crypto.createHash('sha1').update(bytes).digest('hex'))
    assert(result.expiresAt > Date.now())
    const files = await createFiles(config)
    await assert.rejects(files.read(job.uploadPath), { code: 'ENOENT' })
    console.log(JSON.stringify({ realWechat: true, publicHttps: true, status: result.status,
      sourceDigestMatched: true, temporaryImageDeleted: true, elapsedMs: Date.now() - started }))
  } finally {
    try {
    if (job) {
      try { await call('/jobs/' + job.jobId + '/image', 'DELETE') } finally {
      await pool.execute("DELETE FROM moderation_jobs WHERE id=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.openid'))=?",
        [job.jobId, identity])
      }
    }
    await pool.execute('DELETE FROM moderation_limits WHERE id=?',
      [crypto.createHash('sha256').update(identity).digest('hex')])
    } finally { await pool.end() }
  }
}
main().catch(() => { console.error('Live synchronous moderation smoke failed; no private data displayed'); process.exitCode = 1 })
