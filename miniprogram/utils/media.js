function chooseImages(count, sourceType) {
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
        reject(error)
      }
    })
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
  return new Promise(function save(resolve, reject) {
    wx.saveImageToPhotosAlbum({
      filePath: path,
      success: function success() {
        resolve()
      },
      fail: function fail(error) {
        const message = (error && error.errMsg) || ''
        if (/auth deny|auth denied|authorize/i.test(message)) {
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
        reject(error)
      }
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
  getFileInfo,
  previewImage,
  saveImage
}

