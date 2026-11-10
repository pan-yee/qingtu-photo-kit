// Read-only public download probe. Never prints the signed URL or image contents.
const mysql = require('mysql2/promise')
const crypto = require('crypto')
const { configuration } = require('../index')
const { createFiles } = require('../files')
async function main() {
  const pool = mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME })
  try {
    const [rows] = await pool.execute('SELECT payload FROM moderation_jobs WHERE status=? AND expires_at>? ORDER BY expires_at DESC LIMIT 1',
      ['pending', Date.now()])
    if (!rows.length) throw new Error('No pending image')
    const job = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload
    const files = await createFiles(configuration(process.env))
    const url = await files.url(job.fileId)
    for (const method of ['HEAD', 'GET']) {
      const response = await fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(15000) })
      const bytes = Buffer.from(await response.arrayBuffer())
      console.log(JSON.stringify({ method, status: response.status,
        contentType: response.headers.get('content-type'),
        matches: method === 'GET' ? crypto.createHash('sha1').update(bytes).digest('hex') === job.sha1 : undefined }))
    }
  } finally { await pool.end() }
}
main().catch(() => { console.error('Public media probe failed; no private data displayed'); process.exitCode = 1 })
