// WeChat-side network diagnostics. Never prints access tokens or credentials.
async function main() {
  const credential = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credential', appid: process.env.WX_APPID,
      secret: process.env.WX_SECRET }), signal: AbortSignal.timeout(10000)
  }).then(r => r.json())
  if (!credential.access_token) throw new Error('Token unavailable')
  const result = await fetch('https://api.weixin.qq.com/cgi-bin/callback/check?access_token=' +
    encodeURIComponent(credential.access_token), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'all', check_operator: 'DEFAULT' }),
    signal: AbortSignal.timeout(20000)
  }).then(r => r.json())
  console.log(JSON.stringify({ errcode: result.errcode, dns: result.dns, ping: result.ping }))
}
main().catch(() => { console.error('WeChat network diagnostic unavailable'); process.exitCode = 1 })
