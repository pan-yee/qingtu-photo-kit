// Run inside the deployed container. Never prints credentials, tokens or signed URLs.
const assert = require('assert')
const crypto = require('crypto')
async function main() {
  const base = process.env.PUBLIC_BASE_URL
  const health = await fetch(base + '/health', { signal: AbortSignal.timeout(10000) })
  assert.strictEqual(health.status, 200)
  const response = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credential', appid: process.env.WX_APPID,
      secret: process.env.WX_SECRET }), signal: AbortSignal.timeout(10000), redirect: 'error'
  })
  const result = await response.json()
  if (!response.ok || !result.access_token) {
    console.error('WeChat credential probe failed; platform error code=' + Number(result.errcode || -1))
    process.exitCode = 1
    return
  }
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = crypto.randomBytes(12).toString('hex')
  const signature = crypto.createHash('sha1').update([
    process.env.CONTENT_SECURITY_CALLBACK_TOKEN, timestamp, nonce
  ].sort().join('')).digest('hex')
  const query = new URLSearchParams({ timestamp, nonce, signature, echostr: 'qingtu-callback-probe' })
  const challenge = await fetch(base + '/wechat/callback?' + query, { signal: AbortSignal.timeout(10000) })
  assert.strictEqual(challenge.status, 200)
  assert.strictEqual(await challenge.text(), 'qingtu-callback-probe')
  const httpBase = new URL(base); httpBase.protocol = 'http:'
  const httpChallenge = await fetch(httpBase.toString() + '/wechat/callback?' + query, {
    signal: AbortSignal.timeout(10000), redirect: 'manual'
  })
  assert.strictEqual(httpChallenge.status, 200)
  assert.strictEqual(await httpChallenge.text(), 'qingtu-callback-probe')
  const httpForged = await fetch(httpBase.toString() + '/wechat/callback', {
    signal: AbortSignal.timeout(10000), redirect: 'manual'
  })
  assert.strictEqual(httpForged.status, 403)
  const echo = Buffer.from('qingtu-encrypted-probe')
  const length = Buffer.alloc(4); length.writeUInt32BE(echo.length)
  const payload = Buffer.concat([crypto.randomBytes(16), length, echo, Buffer.from(process.env.WX_APPID)])
  const padding = 32 - payload.length % 32
  const key = Buffer.from(process.env.CONTENT_SECURITY_CALLBACK_AES_KEY + '=', 'base64')
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.alloc(padding, padding)])), cipher.final()]).toString('base64')
  const encryptedSignature = crypto.createHash('sha1').update([
    process.env.CONTENT_SECURITY_CALLBACK_TOKEN, timestamp, nonce, encrypted
  ].sort().join('')).digest('hex')
  const encryptedQuery = new URLSearchParams({ timestamp, nonce, msg_signature: encryptedSignature, echostr: encrypted })
  const encryptedChallenge = await fetch(base + '/wechat/callback?' + encryptedQuery, { signal: AbortSignal.timeout(10000) })
  assert.strictEqual(encryptedChallenge.status, 200)
  assert.strictEqual(await encryptedChallenge.text(), echo.toString())
  const forged = await fetch(base + '/wechat/callback', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'pass' }),
    signal: AbortSignal.timeout(10000) })
  assert.strictEqual(forged.status, 403)
  console.log('Live probes passed: public HTTPS health, WeChat credential, HTTP challenge without redirect, signed and encrypted URL challenges, forged callback rejection')
}
main().catch(function (error) {
  console.error('Live HTTPS/WeChat probe failed; code=' + (error.code || error.cause && error.cause.code || 'PROBE_FAILED'))
  process.exitCode = 1
})
