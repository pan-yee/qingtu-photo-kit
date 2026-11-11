// Run inside the app container with a public/non-personal fixture file path.
// Does not replace wx.login or WeChat moderation verification on a real device.
const fs = require('fs/promises')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
async function main() {
  const base = (process.env.SMOKE_BASE_URL || process.env.PUBLIC_BASE_URL).replace(/\/$/, '')
  const denied = await fetch(base + '/jobs/matte', { method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('unauthenticated') })
  if (denied.status !== 401) throw new Error('Authentication check failed')
  const identity = 'matting_probe_' + crypto.randomBytes(8).toString('hex')
  const token = jwt.sign({ openid: identity, appid: process.env.WX_APPID }, process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '60s', issuer: 'qingtu-moderation', audience: 'qingtu-photo-kit' })
  const image = await fs.readFile(process.argv[2])
  const started = Date.now()
  const response = await fetch(base + '/jobs/matte', { method: 'POST', body: image,
    headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(55000) })
  const result = await response.json()
  if (response.status !== 200 || result.ok !== true || result.engine !== 'modnet' ||
      result.width < 32 || result.height < 32 || !result.png || result.protocol !== 2 ||
      result.faceDetector !== 'yunet-2023mar' || !Array.isArray(result.faces) || result.faces.length !== 1) throw new Error('Matting check failed')
  const sharp = require('sharp')
  const mask = Buffer.from(result.png, 'base64')
  const metadata = await sharp(mask).metadata()
  const { data } = await sharp(mask).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true })
  const min = data.reduce((a, b) => Math.min(a, b), 255)
  const max = data.reduce((a, b) => Math.max(a, b), 0)
  if (metadata.width !== result.width || metadata.height !== result.height || min > 20 || max < 235) {
    throw new Error('Invalid matte')
  }
  const elapsedMs = Date.now() - started
  if (process.argv[3]) {
    const invalid = await fs.readFile(process.argv[3])
    const rejected = await fetch(base + '/jobs/matte', { method: 'POST', body: invalid,
      headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(55000) })
    const reason = await rejected.json()
    if (rejected.status !== 422 || reason.code !== 'MATTING_NO_FACE') throw new Error('Unsafe input was not rejected')
  }
  console.log(JSON.stringify({ ok: true, engine: result.engine, protocol: result.protocol,
    faceDetector: result.faceDetector, faces: result.faces.length, width: result.width, height: result.height,
    elapsedMs, negativeInputRejected: Boolean(process.argv[3]), alphaMin: min, alphaMax: max,
    maskSha256: crypto.createHash('sha256').update(mask).digest('hex') }))
}
main().catch(() => { console.error('Matting smoke test failed'); process.exitCode = 1 })
