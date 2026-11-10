// Diagnostic-only synchronous API probe, using a generated non-personal PNG.
const zlib = require('zlib')
function chunk(kind, data) {
  const body = Buffer.concat([Buffer.from(kind), data])
  let crc = 0xffffffff
  for (const byte of body) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([size, body, checksum])
}
async function main() {
  const header = Buffer.alloc(13); header.writeUInt32BE(128); header.writeUInt32BE(128, 4)
  header[8] = 8; header[9] = 2
  const pixels = Buffer.alloc(128 * (1 + 128 * 3))
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const offset = y * 385 + 1 + x * 3
    pixels[offset] = 55; pixels[offset + 1] = 145; pixels[offset + 2] = 105
  }
  const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
  const credential = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credential', appid: process.env.WX_APPID,
      secret: process.env.WX_SECRET }), signal: AbortSignal.timeout(10000)
  }).then(r => r.json())
  if (!credential.access_token) throw new Error('Token unavailable')
  const form = new FormData()
  form.append('media', new Blob([image], { type: 'image/png' }), 'probe.png')
  const response = await fetch('https://api.weixin.qq.com/wxa/img_sec_check?access_token=' +
    encodeURIComponent(credential.access_token), { method: 'POST', body: form, signal: AbortSignal.timeout(20000) })
  const result = await response.json()
  console.log(JSON.stringify({ httpStatus: response.status, errcode: result.errcode,
    explicitSuccess: response.ok && result.errcode === 0 }))
}
main().catch(() => { console.error('Synchronous probe unavailable'); process.exitCode = 1 })
