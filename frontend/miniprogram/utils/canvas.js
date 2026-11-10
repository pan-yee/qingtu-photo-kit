const contentSecurity = require('./content-security')

function createCanvas(width, height) {
  const canvas = wx.createOffscreenCanvas({
    type: '2d',
    width: width,
    height: height
  })
  canvas.width = width
  canvas.height = height
  return canvas
}

function loadImage(canvas, src) {
  return new Promise(function load(resolve, reject) {
    const image = canvas.createImage()
    image.onload = function onLoad() {
      resolve(image)
    }
    image.onerror = function onError(error) {
      reject(error || new Error('图片加载失败'))
    }
    image.src = src
  })
}

function drawImageCover(
  context,
  image,
  x,
  y,
  width,
  height,
  radius
) {
  const imageWidth = image.width || image.naturalWidth
  const imageHeight = image.height || image.naturalHeight
  const imageRatio = imageWidth / imageHeight
  const targetRatio = width / height
  let sx = 0
  let sy = 0
  let sw = imageWidth
  let sh = imageHeight

  if (imageRatio > targetRatio) {
    sw = imageHeight * targetRatio
    sx = (imageWidth - sw) / 2
  } else {
    sh = imageWidth / targetRatio
    sy = (imageHeight - sh) / 2
  }

  context.save()
  roundedRectPath(context, x, y, width, height, radius || 0)
  context.clip()
  context.drawImage(image, sx, sy, sw, sh, x, y, width, height)
  context.restore()
}

function roundedRectPath(context, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius || 0, width / 2, height / 2))
  context.beginPath()
  context.moveTo(x + r, y)
  context.lineTo(x + width - r, y)
  context.quadraticCurveTo(x + width, y, x + width, y + r)
  context.lineTo(x + width, y + height - r)
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - r,
    y + height
  )
  context.lineTo(x + r, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - r)
  context.lineTo(x, y + r)
  context.quadraticCurveTo(x, y, x + r, y)
  context.closePath()
}

function canvasToTempFile(canvas, fileType, quality) {
  return new Promise(function exportFile(resolve, reject) {
    wx.canvasToTempFilePath({
      canvas: canvas,
      fileType: fileType || 'png',
      quality:
        typeof quality === 'number' ? quality : fileType === 'jpg' ? 0.92 : 1,
      success: function success(result) {
        resolve(result.tempFilePath)
      },
      fail: reject
    })
  }).then(async function checked(path) {
    await contentSecurity.ensureSafe(path)
    return path
  })
}

module.exports = {
  canvasToTempFile,
  createCanvas,
  drawImageCover,
  loadImage,
  roundedRectPath
}

