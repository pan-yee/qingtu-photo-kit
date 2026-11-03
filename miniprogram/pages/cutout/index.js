const config = require('../../config/index')
const canvasTools = require('../../utils/canvas')
const media = require('../../utils/media')
const processing = require('../../utils/image-processing')
const rewarded = require('../../utils/rewarded')

Page({
  data: {
    hasImage: false,
    sourceSrc: '',
    resultSrc: '',
    processing: false,
    tolerance: 36,
    backgroundKey: 'white',
    removedPercent: 0,
    backgrounds: [
      { id: 'white', label: '白色', color: '#ffffff' },
      { id: 'blue', label: '蓝色', color: '#438edb' },
      { id: 'red', label: '红色', color: '#d94242' },
      { id: 'gray', label: '灰色', color: '#aeb4b2' },
      { id: 'transparent', label: '透明', color: 'transparent' }
    ]
  },

  onUnload() {
    this._sourceImageData = null
    this._sourceCanvas = null
  },

  async choosePhoto() {
    try {
      const files = await media.chooseImages(1)
      if (!files.length) return
      await this.preparePhoto(files[0].path)
    } catch (error) {
      this.showError(error)
    }
  },

  async preparePhoto(path) {
    this.setData({
      processing: true,
      sourceSrc: path,
      resultSrc: '',
      hasImage: true
    })

    try {
      const dimensions = await this.getImageDimensions(path)
      const width = config.limits.photoWidth
      const height = config.limits.photoHeight
      const canvas = canvasTools.createCanvas(width, height)
      const context = canvas.getContext('2d')
      const image = await canvasTools.loadImage(canvas, path)
      const crop = processing.centerCropRect(
        dimensions.width,
        dimensions.height,
        width,
        height
      )
      context.clearRect(0, 0, width, height)
      context.drawImage(
        image,
        crop.sx,
        crop.sy,
        crop.sw,
        crop.sh,
        0,
        0,
        width,
        height
      )
      this._sourceCanvas = canvas
      this._sourceImageData = context.getImageData(0, 0, width, height)
      await this.renderResult()
    } finally {
      this.setData({ processing: false })
    }
  },

  getImageDimensions(path) {
    return new Promise(function getInfo(resolve, reject) {
      wx.getImageInfo({
        src: path,
        success: resolve,
        fail: reject
      })
    })
  },

  async renderResult() {
    if (!this._sourceImageData) return
    const width = config.limits.photoWidth
    const height = config.limits.photoHeight
    const selected = this.data.backgrounds.find(
      function find(item) {
        return item.id === this.data.backgroundKey
      }.bind(this)
    )

    const cutout = processing.removeBackground(this._sourceImageData, {
      tolerance: this.data.tolerance,
      feather: true
    })
    const cutoutCanvas = canvasTools.createCanvas(width, height)
    const cutoutContext = cutoutCanvas.getContext('2d')
    const cutoutData = cutoutContext.createImageData(width, height)
    cutoutData.data.set(cutout.data)
    cutoutContext.putImageData(cutoutData, 0, 0)

    const outputCanvas = canvasTools.createCanvas(width, height)
    const outputContext = outputCanvas.getContext('2d')
    outputContext.clearRect(0, 0, width, height)
    if (selected && selected.id !== 'transparent') {
      outputContext.fillStyle = selected.color
      outputContext.fillRect(0, 0, width, height)
    }
    outputContext.drawImage(cutoutCanvas, 0, 0)

    const resultSrc = await canvasTools.canvasToTempFile(
      outputCanvas,
      'png',
      1
    )
    this._resultCanvas = outputCanvas
    this.setData({
      resultSrc: resultSrc,
      removedPercent: Math.round(
        (cutout.removedPixels / (width * height)) * 100
      )
    })
  },

  onToleranceChange(event) {
    const tolerance = Number(event.detail.value)
    this.setData({ tolerance: tolerance })
    this.scheduleRender()
  },

  scheduleRender() {
    if (!this._sourceImageData) return
    clearTimeout(this._renderTimer)
    this._renderTimer = setTimeout(
      function run() {
        this.setData({ processing: true })
        this.renderResult()
          .catch(this.showError.bind(this))
          .finally(
            function done() {
              this.setData({ processing: false })
            }.bind(this)
          )
      }.bind(this),
      180
    )
  },

  chooseBackground(event) {
    const key = event.currentTarget.dataset.key
    if (!key || key === this.data.backgroundKey) return
    this.setData({ backgroundKey: key, processing: true })
    this.renderResult()
      .catch(this.showError.bind(this))
      .finally(
        function done() {
          this.setData({ processing: false })
        }.bind(this)
      )
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

  previewResult() {
    if (!this.data.resultSrc) return
    media.previewImage(this.data.resultSrc)
  },

  changePhoto() {
    this.choosePhoto()
  },

  showError(error) {
    console.error(error)
    wx.showToast({
      title: (error && error.message) || '处理失败，请重试',
      icon: 'none'
    })
  }
})

