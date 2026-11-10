const path = require('path')
const mysql = require('mysql2/promise')
const { createStore } = require('./store')
const { createFiles } = require('./files')
const { createWechat } = require('./wechat')
const { createApp } = require('./app')

function configuration(env) {
  const config = {
    appId: env.WX_APPID, appSecret: env.WX_SECRET, jwtSecret: env.JWT_SECRET,
    mediaSecret: env.MEDIA_SIGNING_SECRET, callbackToken: env.CONTENT_SECURITY_CALLBACK_TOKEN,
    callbackAesKey: env.CONTENT_SECURITY_CALLBACK_AES_KEY,
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, 'data'))
  }
  if (!/^wx[a-z0-9]{16}$/i.test(config.appId || '') || !config.appSecret ||
      !/^[A-Za-z0-9+/]{43}$/.test(config.callbackAesKey || '') ||
      !/^[a-zA-Z0-9]{3,32}$/.test(config.callbackToken || '') ||
      [config.jwtSecret, config.mediaSecret].some(value => typeof value !== 'string' || value.length < 32) ||
      config.jwtSecret === config.mediaSecret) throw new Error('Missing or invalid server configuration')
  const url = new URL(config.publicBaseUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('PUBLIC_BASE_URL must be a public HTTPS base URL')
  }
  return config
}
async function main() {
  const config = configuration(process.env)
  if (!process.env.DB_PASS || !process.env.DB_NAME || !process.env.DB_USER) throw new Error('Database configuration required')
  const pool = mysql.createPool({ host: process.env.DB_HOST || 'mysql', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME,
    connectionLimit: 8, charset: 'utf8mb4' })
  const store = await createStore(pool)
  const files = await createFiles(config)
  let cleanupReady = false
  const app = createApp({ config, store, files, wechat: createWechat(config), isReady: () => cleanupReady })
  let cleaning = false
  async function cleanup() {
    if (cleaning) return
    cleaning = true
    try { await files.prune(); await store.prune(Date.now()); cleanupReady = true }
    catch (error) {
      cleanupReady = false
      console.error('Temporary data cleanup failed; new image tasks paused; check server storage/database')
    }
    finally { cleaning = false }
  }
  await cleanup()
  const timer = setInterval(cleanup, 60000)
  timer.unref()
  const server = app.listen(Number(process.env.PORT || 3001), '0.0.0.0', function () {
    console.log('Qingtu moderation server listening')
  })
  server.requestTimeout = 30000
  server.headersTimeout = 15000
  function shutdown() {
    clearInterval(timer)
    server.close(async function () { await pool.end(); process.exit(0) })
    setTimeout(function () { process.exit(1) }, 15000).unref()
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}
if (require.main === module) main().catch(function () {
  console.error('Qingtu server startup failed; verify configuration and database connectivity')
  process.exitCode = 1
})
module.exports = { configuration }
