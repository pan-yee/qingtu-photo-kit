const { assert, test } = require('./harness')
const http = require('../miniprogram/utils/moderation-http')
const canvas = require('../miniprogram/utils/canvas')

async function scenario(accepted, body) {
  const saved = { wx: global.wx, matte: http.matte, create: canvas.createCanvas, load: canvas.loadImage }
  let uploads = 0
  let removed = 0
  http.matte = async function () {
    uploads += 1
    return { ok: true, engine: 'modnet', width: 32, height: 32, png: 'base64-mask' }
  }
  global.wx = { env: { USER_DATA_PATH: '/private' },
    showModal: options => options.success({ confirm: accepted }),
    getFileSystemManager: () => ({
      readFile: options => options.success({ data: new ArrayBuffer(8) }),
      writeFile: options => options.success(),
      unlink: () => { removed += 1 }
    }) }
  canvas.loadImage = async () => ({})
  canvas.createCanvas = () => ({ getContext: () => ({ drawImage() {},
    getImageData: () => ({ data: new Uint8ClampedArray(32 * 32 * 4).fill(64) }) }) })
  const file = require.resolve('../miniprogram/utils/portrait-remote')
  delete require.cache[file]
  try { await body(require(file), () => uploads, () => removed) }
  finally {
    global.wx = saved.wx; http.matte = saved.matte
    canvas.createCanvas = saved.create; canvas.loadImage = saved.load
    delete require.cache[file]
  }
}

test('拒绝高清抠图授权时不向服务器上传', async function () {
  await scenario(false, async (remote, uploads) => {
    await assert.rejects(remote.segment('source.png'), /已取消/)
    assert.strictEqual(uploads(), 0)
  })
})

test('高清抠图解析连续遮罩并清理临时遮罩文件', async function () {
  await scenario(true, async (remote, uploads, removed) => {
    const mask = await remote.segment('source.png')
    assert.strictEqual(mask.matting, true)
    assert.strictEqual(mask.data.length, 1024)
    assert(Math.abs(mask.data[0] - 64 / 255) < .00001)
    assert.strictEqual(uploads(), 1)
    assert.strictEqual(removed(), 1)
  })
})

test('高清抠图区分合法域名和登录错误，不向用户显示模糊英文服务提示', async function () {
  await scenario(true, async remote => {
    http.matte = async () => { throw { diagnostic: { stage: 'session', reason: 'domain_not_allowed' } } }
    await assert.rejects(remote.segment('source.png'), /合法域名/)
    http.matte = async () => { throw { diagnostic: { stage: 'wx_login', reason: 'unknown' } } }
    await assert.rejects(remote.segment('source.png'), /微信登录失败/)
    http.matte = async () => { throw { diagnostic: { stage: 'matting', reason: 'timeout' } } }
    await assert.rejects(remote.segment('source.png'), /连接超时/)
    http.matte = async () => { throw { diagnostic: { stage: 'session', reason: 'network_failed' } } }
    await assert.rejects(remote.segment('source.png'), /无法连接图片服务/)
  })
})
