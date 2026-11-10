const { assert, test } = require('./harness')
const diagnostics = require('../miniprogram/utils/moderation-diagnostics')

test('诊断元数据只保留已知枚举、受限数字和随机请求号', function () {
  const error = { diagnostic: { stage: 'https://secret.example', reason: 'Bearer private-token',
    platformCode: 'token-value', httpStatus: 9000, requestId: 'openid_user_secret', url: 'private-url' },
    errMsg: 'unknown private content' }
  assert.deepStrictEqual(diagnostics.metadata(error, 'cloud_allocate'), { stage: 'cloud_allocate', reason: 'unknown' })
  assert.deepStrictEqual(diagnostics.metadata({ errCode: -502005, errMsg: 'DATABASE_COLLECTION_NOT_EXIST secret' }, 'cloud_allocate'), {
    stage: 'cloud_allocate', reason: 'database_not_ready', platformCode: -502005
  })
})
