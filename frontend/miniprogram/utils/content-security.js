const config = require('../config/index')
const http = require('./moderation-http')
const diagnostics = require('./moderation-diagnostics')
const MAX_BYTES = 10 * 1024 * 1024
const approved = new Map()
const pending = new Map()
let consent = null
let initializedEnv = ''
let activeChecks = 0

function failure(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function unavailable(cause, stage, reason) {
  const error = failure('CONTENT_SECURITY_UNAVAILABLE', '内容安全校验暂不可用，请稍后重试')
  error.diagnostic = diagnostics.metadata(cause, stage, reason)
  return error
}

function settings() {
  const value = config.contentSecurity
  const backend = value && (value.backend === undefined ? 'cloud' : value.backend)
  if (backend !== 'cloud' && backend !== 'http') throw unavailable(null, 'configuration', 'invalid_configuration')
  if (backend === 'http') {
    try { http.validate() } catch (error) { throw unavailable(error, 'configuration') }
    return value
  }
  if (typeof value.envId !== 'string' || !value.envId.trim() ||
      typeof value.functionName !== 'string' || !value.functionName.trim()) {
    throw unavailable(null, 'configuration', 'invalid_configuration')
  }
  if (!wx.cloud || typeof wx.cloud.callFunction !== 'function' || typeof wx.cloud.uploadFile !== 'function') {
    throw unavailable(null, 'cloud_init', 'unsupported_api')
  }
  if (initializedEnv !== value.envId) {
    if (typeof wx.cloud.init !== 'function') throw unavailable(null, 'cloud_init', 'unsupported_api')
    try { wx.cloud.init({ env: value.envId, traceUser: false }) }
    catch (error) { throw unavailable(error, 'cloud_init') }
    initializedEnv = value.envId
  }
  return value
}

function timed(promise, milliseconds, stage) {
  let timer
  return Promise.race([promise, new Promise(function (resolve, reject) {
    timer = setTimeout(function () { reject(unavailable(null, stage, 'timeout')) }, milliseconds)
  })]).finally(function () { clearTimeout(timer) })
}

async function checkWithProgress(path, digest) {
  activeChecks += 1
  if (activeChecks === 1 && wx.showLoading) wx.showLoading({ title: '内容安全检测中', mask: true })
  try { return await perform(path, digest) } finally {
    activeChecks -= 1
    if (!activeChecks && wx.hideLoading) wx.hideLoading()
  }
}

async function authorizeUpload() {
  if (!consent) {
    const destination = settings().backend === 'http' ? '运营者服务器' : '本小程序的微信云开发环境'
    consent = new Promise(function ask(resolve, reject) {
      wx.showModal({
        title: '图片内容安全检测',
        content: '图片及处理结果需临时上传至' + destination + '，交由微信内容安全服务检测，检测完成后删除。是否同意？',
        confirmText: '同意检测', cancelText: '暂不使用',
        success: function (result) {
          if (result.confirm) resolve()
          else reject(failure('CONTENT_SECURITY_CANCELLED', '已取消图片检测'))
        },
        fail: function () { reject(unavailable()) }
      })
    }).catch(function denied(error) { consent = null; throw error })
  }
  await consent
}

function fingerprint(path) {
  return new Promise(function (resolve, reject) {
    wx.getFileSystemManager().getFileInfo({
      filePath: path, digestAlgorithm: 'sha1',
      success: function (result) {
        if (!/^[a-f0-9]{40}$/i.test(result.digest || '') || !result.size || result.size > MAX_BYTES) {
          reject(failure('CONTENT_SECURITY_FILE_INVALID', '请选择不超过 10 MB 的 JPG 或 PNG 图片'))
          return
        }
        resolve({ digest: result.digest.toLowerCase(), size: result.size })
      },
      fail: function (error) { reject(unavailable(error, 'fingerprint')) }
    })
  })
}

async function rpc(data) {
  const current = settings()
  if (current.backend === 'http') return timed(http.rpc(data), data.action === 'submit' ? 60000 : 20000, data.action)
  try {
    const response = await timed(wx.cloud.callFunction({
      name: current.functionName, config: { env: current.envId }, data
    }), 20000, 'cloud_' + data.action)
    const result = response && response.result
    if (!result || result.ok !== true) {
      throw unavailable({ diagnostic: result && result.diagnostic }, 'cloud_' + data.action, 'service_rejected')
    }
    return result
  } catch (error) { throw unavailable(error, 'cloud_' + data.action) }
}

async function perform(path, digest) {
  const allocation = await rpc({ action: 'allocate' })
  if (!/^[a-f0-9]{32}$/.test(allocation.jobId || '') ||
      typeof allocation.uploadPath !== 'string' || !allocation.uploadPath.startsWith('moderation-inbox/')) {
    throw unavailable(null, 'allocation_response', 'invalid_response')
  }
  let fileId
  try {
    if (settings().backend === 'http') {
      fileId = await timed(http.upload(allocation, path), 30000, 'upload')
    } else {
      let result
      try {
        result = await timed(wx.cloud.uploadFile({ cloudPath: allocation.uploadPath, filePath: path,
          config: { env: settings().envId } }), 30000, 'cloud_upload')
      } catch (error) { throw unavailable(error, 'cloud_upload') }
      fileId = result.fileID
    }
    let status = await rpc({ action: 'submit', jobId: allocation.jobId, fileId })
    const deadline = Date.now() + 60000
    while (true) {
      if (status.jobId !== allocation.jobId) throw unavailable(null, 'audit_response', 'invalid_response')
      if (status.sha1 !== digest) throw unavailable(null, 'file_binding', 'digest_mismatch')
      if (status.status === 'pass') {
        const expires = Math.min(Number(status.expiresAt), Date.now() + 5 * 60000)
        if (!Number.isFinite(expires) || expires <= Date.now()) throw unavailable(null, 'audit_response', 'invalid_expiry')
        const current = await fingerprint(path)
        if (current.digest !== digest) throw unavailable(null, 'file_binding', 'file_changed')
        if (approved.size >= 100) approved.delete(approved.keys().next().value)
        approved.set(digest, expires)
        return
      }
      if (status.status === 'reject') {
        throw failure('CONTENT_SECURITY_REJECTED', '所发布内容含违规信息')
      }
      if (status.status !== 'pending') throw unavailable(null, 'audit_response', 'invalid_status')
      if (Date.now() >= deadline) throw failure('CONTENT_SECURITY_PENDING', '安全校验暂未完成，请稍后重试')
      await new Promise(function (resolve) { setTimeout(resolve, 1500) })
      status = await rpc({ action: 'status', jobId: allocation.jobId })
    }
  } finally {
    if (settings().backend === 'http') {
      try { await timed(http.remove(allocation.jobId), 5000) } catch (error) {
        // 服务端按任务有效期独立清理，客户端断开不会永久保留图片。
      }
    } else if (fileId && wx.cloud.deleteFile) {
      try { await timed(wx.cloud.deleteFile({ fileList: [fileId], config: { env: settings().envId } }), 5000) } catch (error) {
        // 服务端还会删除上传文件；异常残留由云存储生命周期清理。
      }
    }
  }
}

async function ensureSafeInternal(path) {
  settings()
  await authorizeUpload()
  const current = await fingerprint(path)
  if ((approved.get(current.digest) || 0) > Date.now()) return
  let operation = pending.get(current.digest)
  if (!operation) {
    operation = checkWithProgress(path, current.digest)
    pending.set(current.digest, operation)
  }
  try { await operation } catch (error) {
    if (error && /^CONTENT_SECURITY_/.test(error.code || '')) throw error
    throw unavailable(error)
  } finally { pending.delete(current.digest) }
  // 同内容不同路径的并发调用也必须检查本地文件没有被替换。
  if ((await fingerprint(path)).digest !== current.digest) throw unavailable(null, 'file_binding', 'file_changed')
}

async function ensureSafe(path) {
  try { await ensureSafeInternal(path) } catch (error) {
    if (error && (error.code === 'CONTENT_SECURITY_CANCELLED' || error.code === 'CONTENT_SECURITY_REJECTED')) throw error
    const wrapped = error && /^CONTENT_SECURITY_/.test(error.code || '') ? error : unavailable(error)
    diagnostics.report(wrapped)
    throw wrapped
  }
}

module.exports = { ensureSafe }
