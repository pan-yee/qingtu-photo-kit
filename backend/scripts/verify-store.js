// Deployment smoke test on the dedicated photo database. Removes only its own random rows.
const crypto = require('crypto')
const assert = require('assert')
const mysql = require('mysql2/promise')
const { createStore } = require('../store')
async function main() {
  const pool = mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME })
  if (process.env.DB_NAME !== 'qingtu_photo') throw new Error('Dedicated photo database required')
  const store = await createStore(pool)
  const id = crypto.randomBytes(16).toString('hex')
  const trace = 'probe_' + id
  const identity = 'deployment_probe_' + id
  const limitId = crypto.createHash('sha256').update(identity).digest('hex')
  try {
    await store.add({ id, openid: identity, status: 'reserved', expiresAt: Date.now() + 60000 })
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      store.transition(id, 'reserved', { status: 'pending', traceId: trace })))
    assert.strictEqual(results.filter(Boolean).length, 1)
    assert.strictEqual((await store.byTrace(trace)).status, 'pending')
    await store.saveReceipt(trace, { trace_id: trace, errcode: 0 }, Date.now() + 60000)
    assert.strictEqual((await store.takeReceipt(trace)).errcode, 0)
    assert.strictEqual(await store.takeReceipt(trace), null)
    const window = Math.floor(Date.now() / 60000)
    await Promise.all(Array.from({ length: 20 }, () => store.rateLimit(identity, window, 20)))
    await assert.rejects(store.rateLimit(identity, window, 20))
    console.log('MySQL 8 smoke test passed: JSON, trace lookup, atomic transition, receipt consumption, transactional rate limit')
  } finally {
    await pool.execute('DELETE FROM moderation_jobs WHERE id=?', [id])
    await pool.execute('DELETE FROM moderation_receipts WHERE trace_id=?', [trace])
    await pool.execute('DELETE FROM moderation_limits WHERE id=?', [limitId])
    await pool.end()
  }
}
main().catch(function () { console.error('Dedicated photo MySQL smoke test failed'); process.exitCode = 1 })
