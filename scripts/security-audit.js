/** 本地代码与内容安全接入约束检查；不能替代微信平台的版本安全校验。 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const vm = require('vm')
const root = path.resolve(__dirname, '..')
const appRoot = path.join(root, 'miniprogram')

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(function (entry) {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(file) : [file]
  })
}

function auditSource(source) {
  const issues = []
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(source)) issues.push('dynamic-code')
  if (/\bwx\.(?:request|uploadFile|downloadFile|connectSocket)\s*\(/.test(source)) {
    issues.push('unapproved-network-api')
  }
  if (/\b(?:appsecret|access_token|client_secret)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(source)) {
    issues.push('embedded-credential')
  }
  return issues
}

function audit() {
  const errors = []
  const files = walk(appRoot)
  ;['index.js', 'service.js', 'callback.js'].forEach(function (name) {
    const file = path.join(root, 'cloudfunctions/contentSecurity', name)
    try { new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }) }
    catch (error) { errors.push('Cloud function syntax: ' + error.message) }
  })
  files.filter(function (file) { return file.endsWith('.js') }).forEach(function (file) {
    const source = fs.readFileSync(file, 'utf8')
    if (/wx\.cloud\.(?:callFunction|uploadFile|deleteFile)\s*\(/.test(source) &&
        file !== path.join(appRoot, 'utils/content-security.js')) {
      errors.push(path.relative(root, file) + ': cloud network access must use the content-security module')
    }
    if (/wx\.(?:saveImageToPhotosAlbum|previewImage)\s*\(/.test(source) &&
        file !== path.join(appRoot, 'utils/media.js')) {
      errors.push(path.relative(root, file) + ': image output must use guarded media helpers')
    }
    auditSource(source).forEach(function (issue) {
      errors.push(path.relative(root, file) + ': ' + issue)
    })
  })
  const bytes = files.reduce(function (total, file) { return total + fs.statSync(file).size }, 0)
  if (bytes > 2 * 1024 * 1024) errors.push('Raw main-package files exceed conservative 2 MiB budget')
  const manifest = JSON.parse(fs.readFileSync(path.join(appRoot, 'models/manifest.json'), 'utf8'))
  const digest = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(appRoot, 'models/selfie-segmentation.onnx'))).digest('hex')
  if (digest !== manifest.sha256) errors.push('Portrait model checksum mismatch')
  if (errors.length) throw new Error(errors.join('\n'))
  console.log('Local security checks passed: no dynamic code, unapproved network APIs or embedded credentials detected; ' +
    'model checksum valid; raw main package ' + bytes + ' bytes. WeChat platform audit remains separate.')
  if (!require('../miniprogram/config/index').contentSecurity.envId) {
    console.log('Cloud moderation environment is not configured; image selection, preview and saving remain blocked.')
  }
}

if (require.main === module) {
  try { audit() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { auditSource }
