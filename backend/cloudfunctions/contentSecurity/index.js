const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { createService, COLLECTION } = require('./service')
const { readCallback } = require('./callback')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database({ throwOnNotFound: false })
const APP_ID = process.env.CONTENT_SECURITY_APP_ID || 'wx2b68d0818781b66d'
const jobs = db.collection(COLLECTION)
const receipts = db.collection('content_security_receipts')

function first(result) {
  return Array.isArray(result.data) ? result.data[0] : result.data
}

const store = {
  async get(id) { return first(await jobs.where({ _id: id }).limit(1).get()) },
  async add(job) { await jobs.doc(job.id).set({ data: job }) },
  async update(id, patch) { await jobs.doc(id).update({ data: patch }) },
  async transition(id, previous, patch) {
    const result = await jobs.where({ _id: id, status: previous }).update({ data: patch })
    return result.stats.updated === 1
  },
  async byTrace(traceId) { return first(await jobs.where({ traceId }).limit(1).get()) },
  async saveReceipt(traceId, message, expiresAt) {
    await receipts.doc(traceId).set({ data: { message, expiresAt } })
  },
  async takeReceipt(traceId) {
    const row = first(await receipts.where({ _id: traceId }).limit(1).get())
    if (!row) return null
    await receipts.doc(traceId).remove()
    return row.expiresAt > Date.now() ? row.message : null
  },
  async rateLimit(openid, window, limit) {
    const id = crypto.createHash('sha256').update(openid).digest('hex')
    await db.runTransaction(async function (transaction) {
      const reference = transaction.collection('content_security_limits').doc(id)
      const row = first(await reference.get())
      const count = row && row.window === window ? row.count + 1 : 1
      if (count > limit) throw new Error('Rate limit exceeded')
      await reference.set({ data: { window, count, expiresAt: (window + 2) * 60000 } })
    })
  }
}

const files = {
  async read(fileID) {
    const url = await files.url(fileID)
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) })
    if (!response.ok || Number(response.headers.get('content-length')) > 10 * 1024 * 1024) {
      await response.body?.cancel()
      throw new Error('Invalid upload size')
    }
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 10 * 1024 * 1024) throw new Error('Upload too large')
        chunks.push(Buffer.from(chunk.value))
      }
    } finally { await reader.cancel() }
    return Buffer.concat(chunks)
  },
  async write(cloudPath, fileContent) {
    return (await cloud.uploadFile({ cloudPath, fileContent })).fileID
  },
  async url(fileID) {
    const response = await cloud.getTempFileURL({ fileList: [{ fileID, maxAge: 600 }] })
    const item = response.fileList && response.fileList[0]
    if (!item || item.status !== 0) throw new Error('Temporary URL unavailable')
    return item.tempFileURL
  },
  async remove(fileList) { await cloud.deleteFile({ fileList: Array.from(new Set(fileList)) }) }
}
function reportFailure(stage, error) {
  const value = error && (error.errCode === undefined ? error.code : error.errCode)
  const code = /^-?\d{1,10}$/.test(String(value)) ? Number(value) : null
  console.error(JSON.stringify({ event: 'content_security_failure', stage, code }))
}
const service = createService({ store, files, check: input => cloud.openapi.security.mediaCheckAsync(input),
  onFailure: reportFailure })

exports.main = async function (event) {
  if (event && event.httpMethod) {
    try {
      const verified = readCallback(event, {
        token: process.env.CONTENT_SECURITY_CALLBACK_TOKEN,
        aesKey: process.env.CONTENT_SECURITY_CALLBACK_AES_KEY,
        appId: APP_ID
      })
      if (verified.message) await service.receive(verified.message)
      return { statusCode: 200, headers: { 'Content-Type': 'text/plain' },
        body: verified.echo === undefined ? 'success' : verified.echo }
    } catch (error) {
      return { statusCode: 403, headers: { 'Content-Type': 'text/plain' }, body: 'invalid callback' }
    }
  }
  const stages = { allocate: 'cloud_allocate', submit: 'cloud_submit', status: 'cloud_status' }
  let stage = 'cloud_identity'
  function failed(reason, error) {
    reportFailure(stage, error)
    const diagnostic = { stage, reason }
    if (error && Number.isInteger(error.errCode) && Math.abs(error.errCode) <= 999999999) {
      diagnostic.platformCode = error.errCode
    }
    return { ok: false, code: 'CONTENT_SECURITY_UNAVAILABLE', diagnostic }
  }
  try {
    const context = cloud.getWXContext()
    if (context.APPID !== APP_ID) return failed('appid_mismatch')
    stage = 'cloud_configuration'
    if (!process.env.CONTENT_SECURITY_CALLBACK_TOKEN || !process.env.CONTENT_SECURITY_CALLBACK_AES_KEY) {
      return failed('callback_config_missing')
    }
    if (!/^[A-Za-z0-9+/]{43}$/.test(process.env.CONTENT_SECURITY_CALLBACK_AES_KEY)) {
      return failed('callback_config_invalid')
    }
    stage = stages[event && event.action] || 'content_security'
    const result = await service.call(event || {}, context.OPENID)
    const action = ['allocate', 'submit', 'status'].includes(event && event.action) ? event.action : 'unknown'
    console.log(JSON.stringify({ event: 'content_security_action', action, ok: true }))
    return result
  } catch (error) {
    // 只返回固定阶段和数字错误码，不返回原始错误、身份、URL 或微信安全标签。
    return failed('service_rejected', error)
  }
}
