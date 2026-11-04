function ensurePrivacyAuthorization() {
  return new Promise(function check(resolve) {
    if (!wx.getPrivacySetting) {
      resolve()
      return
    }
    wx.getPrivacySetting({
      success: function success(result) {
        if (!result.needAuthorization || !wx.requirePrivacyAuthorize) {
          resolve()
          return
        }
        wx.requirePrivacyAuthorize({
          success: resolve,
          fail: function fail() {
            resolve()
          }
        })
      },
      fail: function fail() {
        // 旧基础库没有隐私检查能力，继续交给原始 API 返回错误。
        resolve()
      }
    })
  })
}

function explainPrivacyError(error) {
  const message = (error && error.errMsg) || ''
  if (/api scope is not declared in the privacy agreement/i.test(message)) {
    const explained = new Error(
      '小程序后台的隐私保护指引尚未声明选图或相册用途，请管理员补充后重试'
    )
    explained.errMsg = message
    explained.code = 'PRIVACY_DECLARATION_MISSING'
    return explained
  }
  return error
}

function createAlbumPermissionError(message) {
  const error = new Error('未获得相册权限，请在设置中开启后重试')
  error.errMsg = message
  error.code = 'ALBUM_PERMISSION_DENIED'
  return error
}

function chooseImages(count, sourceType) {
  return ensurePrivacyAuthorization().then(function authorized() {
    return new Promise(function choose(resolve, reject) {
      wx.chooseMedia({
        count: count || 1,
        mediaType: ['image'],
        sourceType: sourceType || ['album', 'camera'],
        sizeType: ['original', 'compressed'],
        success: function success(result) {
          resolve(
            (result.tempFiles || []).map(function mapFile(file) {
              return {
                path: file.tempFilePath,
                size: file.size,
                type: file.fileType || 'image',
                width: file.width,
                height: file.height
              }
            })
          )
        },
        fail: function fail(error) {
          if (error && /cancel/i.test(error.errMsg || '')) {
            resolve([])
            return
          }
          reject(explainPrivacyError(error))
        }
      })
    })
  })
}

function getImageInfo(path) {
  return new Promise(function info(resolve, reject) {
    wx.getImageInfo({ src: path, success: resolve, fail: reject })
  })
}

function getFileInfo(path) {
  return new Promise(function info(resolve) {
    if (!wx.getFileInfo) {
      resolve({ size: 0 })
      return
    }
    wx.getFileInfo({
      filePath: path,
      success: resolve,
      fail: function fail() {
        resolve({ size: 0 })
      }
    })
  })
}

function saveImage(path) {
  return ensurePrivacyAuthorization().then(function authorized() {
    return new Promise(function save(resolve, reject) {
      wx.saveImageToPhotosAlbum({
        filePath: path,
        success: function success() {
          resolve()
        },
        fail: function fail(error) {
          const message = (error && error.errMsg) || ''
          const denied = /auth deny|auth denied|authorize/i.test(message)
          if (denied) {
            wx.showModal({
              title: '需要相册权限',
              content: '请在设置中允许保存图片到相册。',
              confirmText: '去设置',
              success: function open(result) {
                if (result.confirm) {
                  wx.openSetting({})
                }
              }
            })
          }
          reject(
            denied
              ? createAlbumPermissionError(message)
              : explainPrivacyError(error)
          )
        }
      })
    })
  })
}

function previewImage(current, urls) {
  wx.previewImage({
    current: current,
    urls: urls || [current]
  })
}

module.exports = {
  chooseImages,
  ensurePrivacyAuthorization,
  getFileInfo,
  getImageInfo,
  previewImage,
  saveImage
}

