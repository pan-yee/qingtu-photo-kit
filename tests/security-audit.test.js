const { assert, test } = require('./harness')
const { auditSource } = require('../scripts/security-audit')

test('本地安全检查识别动态代码、联网接口和内嵌凭据', function () {
  assert.deepStrictEqual(auditSource('eval(payload)'), ['dynamic-code'])
  assert.deepStrictEqual(auditSource('new Function(code)'), ['dynamic-code'])
  assert.deepStrictEqual(auditSource('wx.uploadFile({filePath})'), ['unapproved-network-api'])
  assert.deepStrictEqual(auditSource("const appsecret = 'example-not-a-real-secret'"), ['embedded-credential'])
  assert.deepStrictEqual(auditSource('wx.createInferenceSession({model})'), [])
})
