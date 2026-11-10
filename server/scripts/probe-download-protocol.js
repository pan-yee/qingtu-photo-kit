// Isolated transport probe using ONLY a generated non-personal test image.
const crypto = require('crypto')
async function main() {
  const credential = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credential', appid: process.env.WX_APPID,
      secret: process.env.WX_SECRET }), signal: AbortSignal.timeout(10000)
  }).then(r => r.json())
  if (!credential.access_token) throw new Error('Token unavailable')
  const results = []
  for (const protocol of ['https', 'http']) {
    let stage = 'download'
    try {
    const url = protocol + '://www.ai-dreams.xyz' + process.env.PROBE_PATH
    const download = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
    if (download.status !== 200) { results.push({ protocol, stage, httpStatus: download.status }); continue }
    stage = 'submit'
    // The legacy API is diagnostic-only: never associates a production job or grants approval.
    const result = await fetch('https://api.weixin.qq.com/wxa/media_check_async?access_token=' +
      encodeURIComponent(credential.access_token), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_url: url, media_type: 2 }), signal: AbortSignal.timeout(10000)
    }).then(r => r.json())
    results.push({ protocol, errcode: result.errcode,
      traceKey: typeof result.trace_id === 'string'
        ? crypto.createHash('sha256').update(result.trace_id).digest('hex').slice(0, 12) : null })
    } catch (error) { results.push({ protocol, stage, error: 'PROBE_UNAVAILABLE' }) }
  }
  console.log(JSON.stringify(results))
}
main().catch(() => { console.error('Protocol probe unavailable; no private data displayed'); process.exitCode = 1 })
