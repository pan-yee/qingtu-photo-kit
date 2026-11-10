function createWechat(config, request = fetch, report = () => {}, prepareImage) {
  let cached = null
  let loading = null
  async function json(url, body) {
    const response = await request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000), redirect: 'error'
    })
    if (!response.ok) throw new Error('WeChat service unavailable')
    return response.json()
  }
  async function accessToken() {
    if (cached && cached.expiresAt > Date.now()) return cached.token
    if (!loading) loading = (async function () {
      const result = await json('https://api.weixin.qq.com/cgi-bin/stable_token', {
        grant_type: 'client_credential', appid: config.appId, secret: config.appSecret
      })
      report({ event: 'wechat_token', errcode: Number.isInteger(result.errcode) ? result.errcode : null,
        accepted: typeof result.access_token === 'string' })
      if (!result.access_token || !Number.isFinite(result.expires_in) || result.expires_in < 300) {
        throw new Error('WeChat token unavailable')
      }
      cached = { token: result.access_token, expiresAt: Date.now() + (result.expires_in - 300) * 1000 }
      return cached.token
    })().finally(function () { loading = null })
    return loading
  }
  return {
    async checkImage(buffer) {
      const prepare = prepareImage || require('./audit-image').prepareAuditImage
      const image = await prepare(buffer)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = await accessToken()
        const form = new FormData()
        form.append('media', new Blob([image], { type: 'image/jpeg' }), 'audit.jpg')
        const response = await request('https://api.weixin.qq.com/wxa/img_sec_check?access_token=' +
          encodeURIComponent(token), { method: 'POST', body: form,
          signal: AbortSignal.timeout(15000), redirect: 'error' })
        if (!response.ok) throw new Error('WeChat image check unavailable')
        const result = await response.json()
        report({ event: 'wechat_sync', errcode: Number.isInteger(result.errcode) ? result.errcode : null,
          accepted: result.errcode === 0 })
        if ([40001, 40014, 42001].includes(result.errcode) && attempt === 0) { cached = null; continue }
        return result
      }
      throw new Error('WeChat image check unavailable')
    },
    async login(code) {
      const url = new URL('https://api.weixin.qq.com/sns/jscode2session')
      url.search = new URLSearchParams({ appid: config.appId, secret: config.appSecret,
        js_code: code, grant_type: 'authorization_code' }).toString()
      const response = await request(url, { signal: AbortSignal.timeout(10000), redirect: 'error' })
      if (!response.ok) throw new Error('WeChat login unavailable')
      const value = await response.json()
      report({ event: 'wechat_login', errcode: Number.isInteger(value.errcode) ? value.errcode : null,
        accepted: !value.errcode && typeof value.openid === 'string' })
      if (value.errcode || typeof value.openid !== 'string' || !/^[\w-]{10,128}$/.test(value.openid)) {
        throw new Error('WeChat login unavailable')
      }
      return value.openid
    },
    async check(input) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = await accessToken()
        const result = await json('https://api.weixin.qq.com/wxa/media_check_async?access_token=' +
          encodeURIComponent(token), { media_url: input.mediaUrl, media_type: 2, version: 2,
          scene: 2, openid: input.openid })
        report({ event: 'wechat_submit', errcode: Number.isInteger(result.errcode) ? result.errcode : null,
          accepted: result.errcode === 0 && typeof result.trace_id === 'string' })
        if ([40001, 40014, 42001].includes(result.errcode) && attempt === 0) { cached = null; continue }
        return result
      }
      throw new Error('WeChat audit unavailable')
    }
  }
}
module.exports = { createWechat }
