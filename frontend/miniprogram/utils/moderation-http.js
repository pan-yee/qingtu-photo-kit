const config = require('../config/index')
const diagnostics = require('./moderation-diagnostics')
let session = null
let signingIn = null

function validate() {
  const baseUrl = config.contentSecurity && config.contentSecurity.apiBaseUrl
  if (typeof baseUrl !== 'string' || !/^https:\/\/[a-z0-9.-]+(?::443)?(?:\/[a-z0-9_-]+)*$/i.test(baseUrl) ||
      typeof wx.request !== 'function' || typeof wx.login !== 'function') throw diagnostics.error(null, 'configuration', 'invalid_configuration')
  return baseUrl
}
function request(path, method, data, token, binary) {
  const baseUrl = validate()
  const stage = path === '/jobs/matte' ? 'matting' : path === '/session' ? 'session' : path === '/jobs' ? 'allocate'
    : path.endsWith('/submit') ? 'submit' : path.endsWith('/status') ? 'status'
      : method === 'DELETE' ? 'cleanup' : 'upload'
  return new Promise(function (resolve, reject) {
    wx.request({ url: baseUrl + path, method, data,
      timeout: path === '/jobs/matte' ? 55000 : binary ? 30000 : path.endsWith('/submit') ? 55000 : 20000,
      header: Object.assign({ 'Content-Type': binary ? 'application/octet-stream' : 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {}),
      success: function (response) {
        if (response.statusCode >= 200 && response.statusCode < 300 && response.data && response.data.ok === true) {
          resolve(response.data)
        } else {
          const responseId = response.header && (response.header['X-Request-ID'] || response.header['x-request-id']) ||
            response.data && response.data.requestId
          reject(diagnostics.error({ statusCode: response.statusCode, diagnostic: { requestId: responseId } },
            stage, response.statusCode >= 200 && response.statusCode < 300 ? 'invalid_response' : 'http_error'))
        }
      }, fail: function (error) { reject(diagnostics.error(error, stage)) }
    })
  })
}
async function login() {
  const baseUrl = validate()
  if (session && session.baseUrl === baseUrl && session.expiresAt > Date.now()) return session.token
  if (!signingIn) signingIn = (async function () {
    const code = await new Promise(function (resolve, reject) {
      wx.login({ timeout: 10000, success: function (value) {
        if (!value.code) reject(diagnostics.error(null, 'wx_login', 'invalid_response'))
        else resolve(value.code)
      }, fail: function (error) { reject(diagnostics.error(error, 'wx_login')) } })
    })
    const result = await request('/session', 'POST', { code })
    if (typeof result.token !== 'string' || result.token.length > 4096 || !result.token ||
        !Number.isFinite(result.expiresIn) || result.expiresIn < 120 || result.expiresIn > 3600) {
      throw diagnostics.error(null, 'session', 'invalid_response')
    }
    // 不持久化登录凭据；仅用于当前小程序会话中的图片检测。
    session = { baseUrl, token: result.token, expiresAt: Date.now() + (result.expiresIn - 60) * 1000 }
    return result.token
  })().finally(function () { signingIn = null })
  return signingIn
}
async function authenticated(path, method, data, binary) {
  try { return await request(path, method, data, await login(), binary) }
  catch (error) {
    if (error.statusCode !== 401) throw error
    session = null
    return request(path, method, data, await login(), binary)
  }
}
function taskPath(id) {
  if (!/^[a-f0-9]{32}$/.test(id || '')) throw new Error('Invalid task ID')
  return '/jobs/' + id
}
module.exports = {
  validate,
  matte(bytes) { return authenticated('/jobs/matte', 'POST', bytes, true) },
  rpc(data) {
    if (data.action === 'allocate') return authenticated('/jobs', 'POST', {})
    if (data.action === 'status') return authenticated(taskPath(data.jobId) + '/status', 'GET')
    if (data.action === 'submit') return authenticated(taskPath(data.jobId) + '/submit', 'POST', { fileId: data.fileId })
    throw new Error('Invalid audit action')
  },
  async upload(allocation, filePath) {
    const bytes = await new Promise(function (resolve, reject) {
      wx.getFileSystemManager().readFile({ filePath, success: function (value) { resolve(value.data) }, fail: function (error) { reject(diagnostics.error(error, 'read_file')) } })
    })
    const result = await authenticated(taskPath(allocation.jobId) + '/image', 'POST', bytes, true)
    if (result.fileId !== allocation.uploadPath) throw diagnostics.error(null, 'upload', 'invalid_response')
    return result.fileId
  },
  remove(jobId) { return authenticated(taskPath(jobId) + '/image', 'DELETE') }
}
