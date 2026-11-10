// Retry one still-live pending image through the normal service, never log its identity or URL.
const mysql = require('mysql2/promise')
const { configuration } = require('../index')
const { createStore } = require('../store')
const { createFiles } = require('../files')
const { createWechat } = require('../wechat')
const { createService } = require('../cloudfunctions/contentSecurity/service')
async function main() {
  const pool = mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME })
  try {
    const [rows] = await pool.execute('SELECT payload FROM moderation_jobs WHERE status=? AND expires_at>? ORDER BY expires_at DESC LIMIT 1',
      ['pending', Date.now()])
    if (!rows.length) { console.log('No live pending image available; select a new image'); return }
    const previous = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload
    const config = configuration(process.env)
    const files = await createFiles(config)
    const bytes = await files.read(previous.fileId)
    const store = await createStore(pool)
    const service = createService({ store, files, check: createWechat(config).check })
    const job = await service.call({ action: 'allocate' }, previous.openid)
    await files.upload(job.uploadPath, bytes)
    let result = await service.call({ action: 'submit', jobId: job.jobId, fileId: job.uploadPath }, previous.openid)
    console.log('Diagnostic retry submitted; status=' + result.status)
    const deadline = Date.now() + 90000
    while (result.status === 'pending' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000))
      result = await service.call({ action: 'status', jobId: job.jobId }, previous.openid)
    }
    const final = await store.get(job.jobId)
    console.log(JSON.stringify({ status: final.status, errcode: final.auditErrcode, suggest: final.auditSuggest }))
  } finally { await pool.end() }
}
main().catch(() => { console.error('Diagnostic retry unavailable; no private data displayed'); process.exitCode = 1 })
