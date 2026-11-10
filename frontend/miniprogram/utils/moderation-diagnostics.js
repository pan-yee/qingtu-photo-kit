// 只记录有限枚举和数字，不输出原始异常、URL、身份、图片路径或凭据。
const STAGES = [
  'configuration', 'cloud_init', 'cloud_allocate', 'cloud_submit', 'cloud_status',
  'cloud_upload', 'cloud_cleanup', 'wx_login', 'session', 'allocate', 'submit',
  'status', 'upload', 'cleanup', 'read_file', 'fingerprint', 'allocation_response',
  'audit_response', 'file_binding', 'content_security', 'cloud_identity', 'cloud_configuration', 'matting'
]
const REASONS = [
  'invalid_configuration', 'unsupported_api', 'domain_not_allowed', 'tls_failed',
  'timeout', 'network_failed', 'permission_denied', 'function_not_found', 'environment_not_found',
  'database_not_ready', 'http_error', 'invalid_response', 'service_rejected',
  'invalid_file', 'file_changed', 'digest_mismatch', 'invalid_expiry', 'invalid_status',
  'appid_mismatch', 'callback_config_missing', 'callback_config_invalid', 'unknown'
]

function classify(error) {
  const message = String(error && (error.errMsg || error.message) || '')
  if (/not in.*domain|domain.*list|合法域名/i.test(message)) return 'domain_not_allowed'
  if (/certificate|ssl|\btls\b/i.test(message)) return 'tls_failed'
  if (/timeout|timed out/i.test(message)) return 'timeout'
  if (/function.*not.*(?:found|exist)|FUNCTION_NOT_FOUND/i.test(message)) return 'function_not_found'
  if (/(?:env|environment).*not.*(?:found|exist)/i.test(message)) return 'environment_not_found'
  if (/collection.*not.*exist|DATABASE_COLLECTION_NOT_EXIST|集合.*不存在/i.test(message)) return 'database_not_ready'
  if (/permission|unauthorized|auth deny/i.test(message)) return 'permission_denied'
  if (/network|connect|offline|request:fail/i.test(message)) return 'network_failed'
  return 'unknown'
}

function metadata(error, stage, reason) {
  const original = error && error.diagnostic || {}
  const result = {
    stage: STAGES.includes(original.stage) ? original.stage : STAGES.includes(stage) ? stage : 'content_security',
    reason: REASONS.includes(original.reason) ? original.reason : REASONS.includes(reason) ? reason : classify(error)
  }
  const status = original.httpStatus === undefined ? error && error.statusCode : original.httpStatus
  if (Number.isInteger(status) && status >= 100 && status <= 599) result.httpStatus = status
  const code = original.platformCode === undefined ? error && error.errCode : original.platformCode
  if (Number.isInteger(code) && Math.abs(code) <= 999999999) result.platformCode = code
  const id = original.requestId
  if (typeof id === 'string' && /^[a-f0-9]{16}$/.test(id)) result.requestId = id
  return result
}

function error(cause, stage, reason) {
  const wrapped = new Error('Moderation service unavailable')
  wrapped.diagnostic = metadata(cause, stage, reason)
  if (wrapped.diagnostic.httpStatus) wrapped.statusCode = wrapped.diagnostic.httpStatus
  return wrapped
}

function report(error) {
  console.warn('[content-security]', JSON.stringify(metadata(error)))
}

module.exports = { error, metadata, report }
