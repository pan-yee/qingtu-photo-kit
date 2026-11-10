const config = require('../../config/index')
const contentSecurity = require('../../utils/content-security')
const exportImage = require('../../utils/export-image')
const feedback = require('../../utils/feedback')
const media = require('../../utils/media')
const processing = require('../../utils/image-processing')

Page({
  data: {
    hasImage: false,
    busy: false,
    sourceSrc: '',
    resultSrc: '',
    sourceSizeText: '—',
    resultSizeText: '—',
    savedPercent: 0,
    width: 0,
    height: 0,
    preset: 'balanced',
    presets: [
      {
        id: 'high',
        label: '高清',
        note: '1600px',
        quality: 90,
        maxSide: 1600
      },
      {
        id: 'balanced',
        label: '均衡',
        note: '1280px',
        quality: 82,
        maxSide: 1280
      },
      {
        id: 'light',
        label: '轻量',
        note: '720px',
        quality: 64,
        maxSide: 720
      }
    ]
  },

  async chooseImage() {
    try {
      const files = await media.chooseImages(1)
      if (!files.length) return
      await this.prepareImage(files[0])
    } catch (error) {
      feedback.showError(error, '读取图片失败，请重试')
    }
  },

  async prepareImage(file) {
    this.setData({ busy: true })
    try {
      const info = await media.getImageInfo(file.path)
      const fileInfo = await media.getFileInfo(file.path)
      this._sourcePath = file.path
      this._sourceWidth = info.width
      this._sourceHeight = info.height
      this._sourceBytes = fileInfo.size || file.size || 0
      this.setData({
        hasImage: true,
        sourceSrc: file.path,
        resultSrc: '',
        width: info.width,
        height: info.height,
        sourceSizeText: processing.formatBytes(this._sourceBytes)
      })
      await this.compressImage()
    } catch (error) {
      feedback.showError(error, '读取图片失败，请重试')
    } finally {
      this.setData({ busy: false })
    }
  },

  getPreset() {
    const presetId = this.data.preset
    return (
      this.data.presets.find(function find(item) {
        return item.id === presetId
      }) || this.data.presets[1]
    )
  },

  async compressImage() {
    if (!this._sourcePath) return
    const token = (this._compressToken || 0) + 1
    this._compressToken = token
    const preset = this.getPreset()
    const maxSide = Math.min(preset.maxSide, config.limits.maxImageSide)
    const ratio = Math.min(
      1,
      maxSide / Math.max(this._sourceWidth, this._sourceHeight)
    )
    const options = {
      src: this._sourcePath,
      quality: preset.quality
    }
    if (ratio < 1) {
      options.compressedWidth = Math.round(this._sourceWidth * ratio)
      options.compressedHeight = Math.round(this._sourceHeight * ratio)
    }

    this.setData({ busy: true })
    try {
      let result
      try {
        result = await this.callCompress(options)
      } catch (error) {
        // 部分旧基础库只支持 quality，不接受尺寸参数。
        result = await this.callCompress({
          src: this._sourcePath,
          quality: preset.quality
        })
      }
      await contentSecurity.ensureSafe(result.tempFilePath)
      const fileInfo = await media.getFileInfo(result.tempFilePath)
      const sourceBytes = this._sourceBytes || 0
      const resultBytes = fileInfo.size
      const saved =
        sourceBytes > 0
          ? Math.max(0, Math.round((1 - resultBytes / sourceBytes) * 100))
          : 0
      // 快速切换清晰度档位时只保留最后一次压缩的结果。
      if (token !== this._compressToken) return
      this._resultPath = result.tempFilePath
      this.setData({
        resultSrc: result.tempFilePath,
        resultSizeText: processing.formatBytes(resultBytes),
        savedPercent: saved
      })
    } catch (error) {
      if (token === this._compressToken) {
        feedback.showError(error, '压缩失败，请重试')
      }
    } finally {
      if (token === this._compressToken) {
        this.setData({ busy: false })
      }
    }
  },

  callCompress(options) {
    return new Promise(function compress(resolve, reject) {
      wx.compressImage({
        ...options,
        success: resolve,
        fail: reject
      })
    })
  },

  selectPreset(event) {
    const preset = event.currentTarget.dataset.id
    if (!preset || preset === this.data.preset) return
    this.setData({ preset: preset })
    this.compressImage()
  },

  changeImage() {
    this.chooseImage()
  },

  previewResult() {
    if (!this.data.resultSrc) return
    media.previewImage(this.data.resultSrc)
  },

  async saveResult() {
    if (!this.data.resultSrc) return
    try {
      await exportImage.saveWithReward(this.data.resultSrc)
    } catch (error) {
      if (!exportImage.isCancelled(error)) {
        feedback.showError(error, '保存失败，请重试')
      }
    }
  }
})

