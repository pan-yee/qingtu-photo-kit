// Read-only aggregate diagnosis. Never prints identities, image paths, hashes or credentials.
const mysql = require('mysql2/promise')
async function main() {
  const pool = mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME })
  try {
    const [jobs] = await pool.query(`SELECT status, COUNT(*) AS count,
      MAX(CAST(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.createdAt')) AS UNSIGNED)) AS last_created_ms,
      SUM(trace_id IS NOT NULL) AS accepted_by_wechat
      FROM moderation_jobs GROUP BY status`)
    const [limits] = await pool.query('SELECT COUNT(*) AS buckets, MAX(count) AS max_calls FROM moderation_limits')
    const [receipts] = await pool.query('SELECT COUNT(*) AS count FROM moderation_receipts')
    const [results] = await pool.query(`SELECT
      JSON_EXTRACT(payload,'$.auditErrcode') AS errcode,
      JSON_UNQUOTE(JSON_EXTRACT(payload,'$.auditSuggest')) AS suggest, COUNT(*) AS count
      FROM moderation_jobs WHERE status IN ('error','reject','pass') GROUP BY errcode,suggest`)
    console.log(JSON.stringify({ jobs, results, rateLimits: limits[0], callbackReceipts: receipts[0] }))
  } finally { await pool.end() }
}
main().catch(function (error) {
  console.error('Aggregate diagnosis failed; code=' + (error.code || 'DATABASE_UNAVAILABLE'))
  process.exitCode = 1
})
