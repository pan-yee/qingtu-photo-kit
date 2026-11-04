const config = require('../../config/index')
const canvasTools = require('../../utils/canvas')
const exportImage = require('../../utils/export-image')
const feedback = require('../../utils/feedback')
const media = require('../../utils/media')
const processing = require('../../utils/image-processing')

Page({
  data: {
    hasImage: false,
    sourceSrc: '',
    resultSrc: '',
    processing: false,
    tolerance: 36,
    feather: 3,
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
    clearTimeout(this._renderTimer)
    this._renderToken = (this._renderToken || 0) + 1
    this._sourceImageData = null
    this._borderColors = null
    this._cutoutWorkspace = null
    this._cutoutCanvas = null
    this._cutoutContext = null
    this._cutoutImageData = null
    this._outputCanvas = null
    this._outputContext = null
  },

  async choosePhoto() {
    try {
      const files = await media.chooseImages(1)
      if (!files.length) return
      await this.preparePhoto(files[0].path)
    } catch (error) {
      feedback.showError(error, '读取图片失败，请重试')
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
      const dimensions = await media.getImageInfo(path)
      const width = config.limits.photoWidth
      const height = config.limits.photoHeight
      const sourceCanvas = canvasTools.createCanvas(width, height)
      const sourceContext = sourceCanvas.getContext('2d')
      const image = await canvasTools.loadImage(sourceCanvas, path)
      const crop = processing.centerCropRect(
        dimensions.width,
        dimensions.height,
        width,
        height
      )
      sourceContext.clearRect(0, 0, width, height)
      sourceContext.drawImage(
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
      this._sourceImageData = sourceContext.getImageData(0, 0, width, height)
      // 边缘背景色和中间缓冲只与照片有关，滑杆重算时直接复用。
      this._borderColors = processing.estimateBorderColors(
        this._sourceImageData.data,
        width,
        height
      )
      this._cutoutWorkspace = processing.createCutoutWorkspace(width, height)

      // 离屏画布与 ImageData 复用，避免每次拖动滑块都重新分配整张照片。
      this._cutoutCanvas = canvasTools.createCanvas(width, height)
      this._cutoutContext = this._cutoutCanvas.getContext('2d')
      this._cutoutImageData = this._cutoutContext.createImageData(
        width,
        height
      )
      this._outputCanvas = canvasTools.createCanvas(width, height)
      this._outputContext = this._outputCanvas.getContext('2d')
      await this.renderResult()
    } finally {
      this.setData({ processing: false })
    }
  },

  async renderResult() {
    if (!this._sourceImageData || !this._outputCanvas) return
    const width = config.limits.photoWidth
    const height = config.limits.photoHeight
    const token = (this._renderToken || 0) + 1
    this._renderToken = token
    const backgroundKey = this.data.backgroundKey
    const selected = this.data.backgrounds.find(function find(item) {
      return item.id === backgroundKey
    })

    const cutout = processing.removeBackground(this._sourceImageData, {
      tolerance: this.data.tolerance,
      feather: true,
      featherRadius: this.data.feather,
      backgroundColors: this._borderColors,
      workspace: this._cutoutWorkspace,
      // 直接写回复用的 ImageData，省掉一次整图拷贝。
      output: this._cutoutImageData.data
    })
    this._cutoutWorkspace = cutout.workspace
    this._cutoutContext.putImageData(this._cutoutImageData, 0, 0)

    this._outputContext.clearRect(0, 0, width, height)
    if (selected && selected.id !== 'transparent') {
      this._outputContext.fillStyle = selected.color
      this._outputContext.fillRect(0, 0, width, height)
    }
    this._outputContext.drawImage(this._cutoutCanvas, 0, 0)

    const resultSrc = await canvasTools.canvasToTempFile(
      this._outputCanvas,
      'png',
      1
    )
    // 拖动滑块会并发多次渲染，只采纳最后一次发起的渲染结果。
    if (token !== this._renderToken) return
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

  onFeatherChange(event) {
    const feather = Number(event.detail.value)
    this.setData({ feather: feather })
    this.scheduleRender()
  },

  scheduleRender() {
    if (!this._sourceImageData) return
    clearTimeout(this._renderTimer)
    this._renderTimer = setTimeout(
      function run() {
        this.setData({ processing: true })
        this.renderResult()
          .catch(function failed(error) {
            feedback.showError(error, '处理失败，请重试')
          })
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
      .catch(function failed(error) {
        feedback.showError(error, '处理失败，请重试')
      })
      .finally(
        function done() {
          this.setData({ processing: false })
        }.bind(this)
      )
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
  },

  previewResult() {
    if (!this.data.resultSrc) return
    media.previewImage(this.data.resultSrc)
  },

  changePhoto() {
    this.choosePhoto()
  }
})

