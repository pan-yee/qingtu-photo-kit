const { assert, test } = require('./harness')
const { auditSource } = require('../scripts/security-audit')

test('本地安全检查识别动态代码、联网接口和内嵌凭据', function () {
  assert.deepStrictEqual(auditSource('eval(payload)'), ['dynamic-code'])
  assert.deepStrictEqual(auditSource('new Function(code)'), ['dynamic-code'])
  assert.deepStrictEqual(auditSource('wx.uploadFile({filePath})'), ['unapproved-network-api'])
  assert.deepStrictEqual(auditSource("const appsecret = 'example-not-a-real-secret'"), ['embedded-credential'])
  assert.deepStrictEqual(auditSource('wx.createInferenceSession({model})'), [])
})

test('HTTP 安全白名单仅允许审核传输模块 request，不放宽其他网络 API 或密钥检查', function () {
  assert.deepStrictEqual(auditSource('wx.request({url})'), ['unapproved-network-api'])
  assert.deepStrictEqual(auditSource('wx.request({url})', { allowModerationHttp: true }), [])
  assert.deepStrictEqual(auditSource('wx.connectSocket({url})', { allowModerationHttp: true }), ['unapproved-network-api'])
  assert.deepStrictEqual(auditSource("const appsecret = 'example-not-a-real-secret'", { allowModerationHttp: true }), ['embedded-credential'])
})
