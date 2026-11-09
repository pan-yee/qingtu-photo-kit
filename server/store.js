const crypto = require('crypto')

async function createStore(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS moderation_jobs (
    id CHAR(32) PRIMARY KEY, trace_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin UNIQUE NULL,
    status VARCHAR(16) NOT NULL, expires_at BIGINT NOT NULL, payload JSON NOT NULL,
    INDEX idx_expiry (expires_at)
  ) ENGINE=InnoDB`)
  await pool.query(`CREATE TABLE IF NOT EXISTS moderation_receipts (
    trace_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, expires_at BIGINT NOT NULL, payload JSON NOT NULL,
    INDEX idx_expiry (expires_at)
  ) ENGINE=InnoDB`)
  await pool.query(`CREATE TABLE IF NOT EXISTS moderation_limits (
    id CHAR(64) PRIMARY KEY, window_id BIGINT NOT NULL, count INT NOT NULL,
    expires_at BIGINT NOT NULL, INDEX idx_expiry (expires_at)
  ) ENGINE=InnoDB`)
  function payload(row) {
    if (!row) return null
    return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
  }
  async function update(id, patch, previous) {
    const sql = `UPDATE moderation_jobs SET payload=JSON_MERGE_PATCH(payload, CAST(? AS JSON)),
      status=COALESCE(?, status), trace_id=COALESCE(?, trace_id) WHERE id=?` +
      (previous === undefined ? '' : ' AND status=?')
    const args = [JSON.stringify(patch), patch.status || null, patch.traceId || null, id]
    if (previous !== undefined) args.push(previous)
    const [result] = await pool.execute(sql, args)
    return result.affectedRows === 1
  }
  return {
    async ping() { await pool.query('SELECT 1') },
    async get(id) { const [rows] = await pool.execute('SELECT payload FROM moderation_jobs WHERE id=?', [id]); return payload(rows[0]) },
    async add(job) {
      await pool.execute('INSERT INTO moderation_jobs (id,status,expires_at,payload) VALUES (?,?,?,?)',
        [job.id, job.status, job.expiresAt, JSON.stringify(job)])
    },
    update,
    transition(id, previous, patch) { return update(id, patch, previous) },
    async byTrace(trace) { const [rows] = await pool.execute('SELECT payload FROM moderation_jobs WHERE trace_id=?', [trace]); return payload(rows[0]) },
    async saveReceipt(trace, message, expiresAt) {
      await pool.execute(`INSERT INTO moderation_receipts (trace_id,expires_at,payload) VALUES (?,?,?)
        ON DUPLICATE KEY UPDATE expires_at=VALUES(expires_at),payload=VALUES(payload)`, [trace, expiresAt, JSON.stringify(message)])
    },
    async takeReceipt(trace) {
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        const [rows] = await conn.execute('SELECT payload,expires_at FROM moderation_receipts WHERE trace_id=? FOR UPDATE', [trace])
        await conn.execute('DELETE FROM moderation_receipts WHERE trace_id=?', [trace])
        await conn.commit()
        return rows[0] && rows[0].expires_at > Date.now() ? payload(rows[0]) : null
      } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
    },
    async rateLimit(identity, window, limit) {
      const id = crypto.createHash('sha256').update(identity).digest('hex')
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        await conn.execute(`INSERT INTO moderation_limits (id,window_id,count,expires_at) VALUES (?,?,1,?)
          ON DUPLICATE KEY UPDATE count=IF(window_id=VALUES(window_id),count+1,1),
          window_id=VALUES(window_id),expires_at=VALUES(expires_at)`, [id, window, (window + 2) * 60000])
        const [rows] = await conn.execute('SELECT count FROM moderation_limits WHERE id=? FOR UPDATE', [id])
        if (rows[0].count > limit) throw new Error('Rate limit exceeded')
        await conn.commit()
      } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
    },
    async prune(now) {
      // 有界批次；图片文件另有独立定时清理，不依赖回调成功。
      await pool.execute('DELETE FROM moderation_jobs WHERE expires_at<? LIMIT 1000', [now])
      await pool.execute('DELETE FROM moderation_receipts WHERE expires_at<? LIMIT 1000', [now])
      await pool.execute('DELETE FROM moderation_limits WHERE expires_at<? LIMIT 1000', [now])
    }
  }
}
module.exports = { createStore }
