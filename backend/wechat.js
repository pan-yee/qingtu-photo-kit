function createWechat(config, request = fetch) {
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
      if (!result.access_token || !Number.isFinite(result.expires_in) || result.expires_in < 300) {
        throw new Error('WeChat token unavailable')
      }
      cached = { token: result.access_token, expiresAt: Date.now() + (result.expires_in - 300) * 1000 }
      return cached.token
    })().finally(function () { loading = null })
    return loading
  }
  return {
    async login(code) {
      const url = new URL('https://api.weixin.qq.com/sns/jscode2session')
      url.search = new URLSearchParams({ appid: config.appId, secret: config.appSecret,
        js_code: code, grant_type: 'authorization_code' }).toString()
      const response = await request(url, { signal: AbortSignal.timeout(10000), redirect: 'error' })
      if (!response.ok) throw new Error('WeChat login unavailable')
      const value = await response.json()
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
        if ([40001, 40014, 42001].includes(result.errcode) && attempt === 0) { cached = null; continue }
        return result
      }
      throw new Error('WeChat audit unavailable')
    }
  }
}
module.exports = { createWechat }
