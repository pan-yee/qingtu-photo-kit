const config = require('../../config/index')
const media = require('../../utils/media')
const processing = require('../../utils/image-processing')
const rewarded = require('../../utils/rewarded')

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
        quality: 88,
        maxSide: 1600
      },
      {
        id: 'balanced',
        label: '均衡',
        note: '1080px',
        quality: 74,
        maxSide: 1080
      },
      {
        id: 'light',
        label: '轻量',
        note: '720px',
        quality: 56,
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
      this.showError(error)
    }
  },

  async prepareImage(file) {
    this.setData({ busy: true })
    try {
      const info = await this.getImageInfo(file.path)
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
        sourceSizeText: processing.formatBytes(fileInfo.size || file.size)
      })
      await this.compressImage()
    } finally {
      this.setData({ busy: false })
    }
  },

  getImageInfo(path) {
    return new Promise(function getInfo(resolve, reject) {
      wx.getImageInfo({ src: path, success: resolve, fail: reject })
    })
  },

  getPreset() {
    return (
      this.data.presets.find(
        function find(item) {
          return item.id === this.data.preset
        }.bind(this)
      ) || this.data.presets[1]
    )
  },

  async compressImage() {
    if (!this._sourcePath) return
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
      const fileInfo = await media.getFileInfo(result.tempFilePath)
      const sourceBytes = this.getSourceBytes()
      const resultBytes = fileInfo.size
      const saved =
        sourceBytes > 0
          ? Math.max(0, Math.round((1 - resultBytes / sourceBytes) * 100))
          : 0
      this._resultPath = result.tempFilePath
      this.setData({
        resultSrc: result.tempFilePath,
        resultSizeText: processing.formatBytes(resultBytes),
        savedPercent: saved
      })
    } catch (error) {
      this.showError(error)
    } finally {
      this.setData({ busy: false })
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

  getSourceBytes() {
    return this._sourceBytes || 0
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
      const unlocked = await rewarded.unlockHighQuality()
      if (!unlocked) {
        wx.showToast({ title: '完整观看后可保存', icon: 'none' })
        return
      }
      await media.saveImage(this.data.resultSrc)
      wx.showToast({ title: '已保存到相册', icon: 'success' })
    } catch (error) {
      if (!/cancel/i.test((error && error.errMsg) || '')) {
        this.showError(error)
      }
    }
  },

  showError(error) {
    console.error(error)
    wx.showToast({
      title: (error && error.message) || '压缩失败，请重试',
      icon: 'none'
    })
  }
})

