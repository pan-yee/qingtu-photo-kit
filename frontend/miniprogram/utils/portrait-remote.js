const http = require('./moderation-http')
const canvasTools = require('./canvas')
const diagnostics = require('./moderation-diagnostics')
const framing = require('./portrait-framing')
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
    const inputMessages = {
      MATTING_NO_FACE: '未检测到清晰人脸，请选择单人正面半身照',
      MATTING_MULTIPLE_FACES: '检测到多个人脸，请选择单人正面照片',
      MATTING_FACE_POSE: '请使用头部端正、面部无遮挡的正面照片',
      MATTING_INCOMPLETE_HEAD: '头部不完整，请换一张包含完整头顶和脸部的照片',
      MATTING_INCOMPLETE_SUBJECT: '人像抠图不完整，请换一张背景更清晰的照片',
      MATTING_IMAGE_TOO_SMALL: '人脸过小，请选择更清晰的正面半身照'
    }
    const message = inputMessages[cause && cause.code] || (diagnostic.httpStatus === 429 ? '图片处理繁忙，请稍后重试'
      : diagnostic.reason === 'domain_not_allowed'
      ? '图片服务域名未配置，请添加 request 合法域名'
      : diagnostic.reason === 'timeout' ? '图片服务连接超时，请切换网络后重试'
        : diagnostic.reason === 'tls_failed' ? '图片服务安全连接失败，请检查网络'
          : diagnostic.reason === 'network_failed' ? '无法连接图片服务，请切换网络后重试'
            : diagnostic.stage === 'wx_login' ? '微信登录失败，请重新打开小程序后重试'
              : diagnostic.stage === 'session' ? '图片服务登录失败，请联系管理员检查登录接口'
                : '高清人像抠图服务暂不可用，请稍后重试')
    const error = new Error(message)
    error.diagnostic = diagnostic
    throw error
  }
  if (result.engine !== 'modnet' || !Number.isInteger(result.width) || !Number.isInteger(result.height) ||
      result.width < 32 || result.height < 32 || result.width > 1024 || result.height > 1024 ||
      typeof result.png !== 'string' || result.png.length > 2000000) throw new Error('人像抠图结果无效')
  if (result.region != null && !framing.validFace(result.region)) throw new Error('人像抠图区域无效')
  if (result.protocol !== 2 || result.faceDetector !== 'yunet-2023mar') throw new Error('图片服务需要更新，请联系管理员')
  if (!Array.isArray(result.faces) || result.faces.length !== 1 || !framing.validFace(result.faces[0])) {
    throw new Error('未检测到清晰的单人正面人脸，请更换照片')
  }
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
    const faces = result.faces
    return { data, width: result.width, height: result.height, matting: true,
      face: faces[0] || null, region: result.region || null }
  } finally { fs.unlink({ filePath: target, fail() {} }) }
}
module.exports = { segment }
