const crypto = require('crypto')

function field(xml, name) {
  const match = String(xml).match(new RegExp('<' + name + '>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</' + name + '>'))
  return match ? match[1] === undefined ? match[2] : match[1] : undefined
}

function signature(parts) {
  return crypto.createHash('sha1').update(parts.slice().sort().join('')).digest('hex')
}

function same(a, b) {
  return typeof a === 'string' && typeof b === 'string' &&
    a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

function verifyQuery(query, token, now, encrypted) {
  if (!token || !/^\d{10}$/.test(query.timestamp || '') ||
      typeof query.nonce !== 'string' || !query.nonce || query.nonce.length > 128 ||
      Math.abs(now / 1000 - Number(query.timestamp)) > 300) throw new Error('Invalid callback')
  const parts = [token, query.timestamp, query.nonce]
  if (encrypted !== undefined) parts.push(encrypted)
  const actual = encrypted === undefined ? query.signature : query.msg_signature
  if (!same(signature(parts), actual)) throw new Error('Invalid callback')
}

function decrypt(encrypted, aesKey, appId) {
  if (!/^[A-Za-z0-9+/]{43}$/.test(aesKey || '') || !appId ||
      typeof encrypted !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) {
    throw new Error('Invalid encrypted callback')
  }
  const key = Buffer.from(aesKey + '=', 'base64')
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)
  const decoded = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()])
  const pad = decoded[decoded.length - 1]
  if (pad < 1 || pad > 32 || decoded.length < pad + 20 ||
      !decoded.subarray(decoded.length - pad).every(value => value === pad)) throw new Error('Invalid padding')
  const payload = decoded.subarray(0, decoded.length - pad)
  const length = payload.readUInt32BE(16)
  if (length > payload.length - 20 || payload.subarray(20 + length).toString() !== appId) {
    throw new Error('Invalid callback receiver')
  }
  return payload.subarray(20, 20 + length).toString('utf8')
}

function parseMessage(text) {
  if (text.trim().startsWith('{')) return JSON.parse(text)
  return {
    MsgType: field(text, 'MsgType'), Event: field(text, 'Event'),
    appid: field(text, 'appid'), trace_id: field(text, 'trace_id'),
    errcode: field(text, 'errcode'),
    result: { suggest: field(text, 'suggest'), label: field(text, 'label') }
  }
}

function readCallback(event, options) {
  const query = event.queryStringParameters || {}
  const now = options.now || Date.now()
  if (event.httpMethod === 'GET') {
    if (query.msg_signature) {
      verifyQuery(query, options.token, now, query.echostr)
      return { echo: decrypt(query.echostr, options.aesKey, options.appId) }
    }
    verifyQuery(query, options.token, now)
    if (typeof query.echostr !== 'string' || query.echostr.length > 2048) throw new Error('Invalid echo')
    return { echo: query.echostr }
  }
  if (event.httpMethod !== 'POST') throw new Error('Invalid method')
  const body = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body
  if (typeof body !== 'string' || Buffer.byteLength(body) > 256 * 1024) throw new Error('Invalid body')
  const encrypted = body.trim().startsWith('{') ? JSON.parse(body).Encrypt : field(body, 'Encrypt')
  // POST 只接受已验签的加密消息，绝不信任客户端传入的 status/pass 或明文回调。
  if (!encrypted) throw new Error('Encrypted callback required')
  verifyQuery(query, options.token, now, encrypted)
  const message = parseMessage(decrypt(encrypted, options.aesKey, options.appId))
  if (message.MsgType !== 'event' || message.Event !== 'wxa_media_check' ||
      message.appid && message.appid !== options.appId ||
      typeof message.trace_id !== 'string' || !/^[\w-]{8,128}$/.test(message.trace_id)) {
    throw new Error('Invalid audit event')
  }
  return { message }
}

module.exports = { readCallback }
