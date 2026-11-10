const http = require('./moderation-http')
const canvasTools = require('./canvas')
const diagnostics = require('./moderation-diagnostics')
let consent = null

async function segment(path) {
  if (!consent) consent = new Promise(function (resolve, reject) {
    wx.showModal({ title: '高清人像抠图',
      content: '照片将临时上传至运营者服务器进行人像抠图，仅在内存中处理，不保存照片。是否同意？',
      confirmText: '同意处理', cancelText: '取消',
      success: result => result.confirm ? resolve() : reject(new Error('已取消人像抠图')),
      fail: () => reject(new Error('无法确认图片上传授权')) })
  }).catch(function (error) { consent = null; throw error })
  await consent
  const fs = wx.getFileSystemManager()
  const bytes = await new Promise((resolve, reject) => fs.readFile({ filePath: path,
    success: result => resolve(result.data), fail: reject }))
  let result
  try { result = await http.matte(bytes) } catch (cause) {
    const diagnostic = diagnostics.metadata(cause, 'matting')
    console.warn('[portrait-matting]', JSON.stringify(diagnostic))
    const message = diagnostic.reason === 'domain_not_allowed'
      ? '图片服务域名未配置，请添加 request 合法域名'
      : diagnostic.reason === 'timeout' ? '图片服务连接超时，请切换网络后重试'
        : diagnostic.reason === 'tls_failed' ? '图片服务安全连接失败，请检查网络'
          : diagnostic.reason === 'network_failed' ? '无法连接图片服务，请切换网络后重试'
            : diagnostic.stage === 'wx_login' ? '微信登录失败，请重新打开小程序后重试'
              : diagnostic.stage === 'session' ? '图片服务登录失败，请联系管理员检查登录接口'
                : '高清人像抠图服务暂不可用，请稍后重试'
    const error = new Error(message)
    error.diagnostic = diagnostic
    throw error
  }
  if (result.engine !== 'modnet' || !Number.isInteger(result.width) || !Number.isInteger(result.height) ||
      result.width < 32 || result.height < 32 || result.width > 1024 || result.height > 1024 ||
      typeof result.png !== 'string' || result.png.length > 2000000) throw new Error('人像抠图结果无效')
  const target = wx.env.USER_DATA_PATH + '/portrait-matte-' + Date.now() + '.png'
  try {
    await new Promise((resolve, reject) => fs.writeFile({ filePath: target, data: result.png,
      encoding: 'base64', success: resolve, fail: reject }))
    const canvas = canvasTools.createCanvas(result.width, result.height)
    const context = canvas.getContext('2d')
    context.drawImage(await canvasTools.loadImage(canvas, target), 0, 0, result.width, result.height)
    const pixels = context.getImageData(0, 0, result.width, result.height).data
    const data = new Float32Array(result.width * result.height)
    for (let i = 0; i < data.length; i += 1) data[i] = pixels[i * 4] / 255
    return { data, width: result.width, height: result.height, matting: true }
  } finally { fs.unlink({ filePath: target, fail() {} }) }
}
module.exports = { segment }
