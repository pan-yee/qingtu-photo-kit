const config = require('../../config/index')
const brushMask = require('../../utils/brush-mask')
const canvasTools = require('../../utils/canvas')
const exportImage = require('../../utils/export-image')
const feedback = require('../../utils/feedback')
const media = require('../../utils/media')
const processing = require('../../utils/image-processing')
const portrait = require('../../utils/portrait-segmentation')
const remotePortrait = require('../../utils/portrait-remote')
const framing = require('../../utils/portrait-framing')

Page({
  data: {
    hasImage: false,
    sourceSrc: '',
    resultSrc: '',
    processing: false,
    tolerance: 36,
    feather: 3,
    edgeCleanup: true,
    backgroundKey: 'white',
    removedPercent: 0,
    portraitMode: false,
    engineNotice: '',
    photoSizeKey: 'one-inch',
    photoSizeLabel: '一寸',
    photoWidth: 295,
    photoHeight: 413,
    photoSizes: [
      { id: 'one-inch', label: '一寸', width: 295, height: 413 },
      { id: 'two-inch', label: '二寸', width: 413, height: 579 },
      { id: 'portrait', label: '3:4 高清', width: 900, height: 1200 }
    ],
    brushMode: false,
    brushTool: 'erase',
    brushSize: 40,
    canUndoBrush: false,
    brushTools: [
      { id: 'erase', label: '擦掉背景' },
      { id: 'restore', label: '找回主体' }
    ],
    backgrounds: [
      { id: 'white', label: '白色', color: '#ffffff' },
      { id: 'blue', label: '蓝色', color: '#438edb' },
      { id: 'red', label: '红色', color: '#d94242' },
      { id: 'gray', label: '灰色', color: '#aeb4b2' },
      { id: 'transparent', label: '透明', color: 'transparent' }
    ]
  },

  onUnload() {
    this._disposed = true
    this._photoToken = (this._photoToken || 0) + 1
    if (this._segmenter) this._segmenter.dispose()
    this._segmenter = null
    this._portraitMask = null
    clearTimeout(this._renderTimer)
    this._renderToken = (this._renderToken || 0) + 1
    this._sourceImageData = null
    this._borderColors = null
    this._textureMap = null
    this._cutoutWorkspace = null
    this._cutoutCanvas = null
    this._cutoutContext = null
    this._cutoutImageData = null
    this._outputCanvas = null
    this._outputContext = null
    this._sourceCanvas = null
    this._brushMask = null
    this._maskUndo = null
    this._brushCanvas = null
    this._brushContext = null
    this._brushRect = null
    this._brushScale = 0
    this._pixelRatio = 0
    this._lastBrushPoint = null
    this._strokeSnapshotPushed = false
  },

  async choosePhoto() {
    if (this.data.processing) return
    try {
      const files = await media.chooseImages(1)
      if (!files.length || this._disposed) return
      await this.preparePhoto(files[0].path)
    } catch (error) {
      feedback.showError(error, '读取图片失败，请重试')
    }
  },

  async preparePhoto(path) {
    clearTimeout(this._renderTimer)
    this._renderToken = (this._renderToken || 0) + 1
    const photoToken = (this._photoToken || 0) + 1
    this._photoToken = photoToken
    this._portraitMask = null
    this.setData({
      processing: true,
      sourceSrc: path,
      resultSrc: '',
      engineNotice: '',
      portraitMode: false,
      hasImage: true
    })

    try {
      const dimensions = await media.getImageInfo(path)
      if (this._disposed || photoToken !== this._photoToken) return
      const width = config.limits.photoWidth
      const height = config.limits.photoHeight
      const sourceCanvas = canvasTools.createCanvas(width, height)
      const sourceContext = sourceCanvas.getContext('2d')
      const image = await canvasTools.loadImage(sourceCanvas, path)
      if (this._disposed || photoToken !== this._photoToken) return
      let crop = processing.centerCropRect(
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
      // 模型每张照片只推理一次，换底色、边缘调整和涂抹复用概率遮罩。
      if (config.portraitBackend !== 'ecs' && !this._segmenter) this._segmenter = portrait.createSegmenter()
      try {
        let mask
        if (config.portraitBackend === 'ecs') {
          // Send the complete photo; locate the face before the final ID crop.
          const input = framing.fitSize(dimensions.width, dimensions.height, config.limits.maxImageSide)
          const fullCanvas = canvasTools.createCanvas(input.width, input.height)
          fullCanvas.getContext('2d').drawImage(image, 0, 0, input.width, input.height)
          const processingPath = await canvasTools.canvasToProcessingFile(fullCanvas, path)
          try { mask = await remotePortrait.segment(processingPath) }
          finally { wx.getFileSystemManager().unlink({ filePath: processingPath, fail() {} }) }
          if (this._disposed || photoToken !== this._photoToken) return
          crop = framing.portraitCrop(dimensions.width, dimensions.height, mask.face, mask, width, height)
          sourceContext.clearRect(0, 0, width, height)
          sourceContext.drawImage(image, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height)
          this._sourceImageData = sourceContext.getImageData(0, 0, width, height)
          this.setData({ engineNotice: crop.faceAligned
            ? '已按人脸辅助构图，请核对头顶留白与办理机构的照片要求。'
            : '未识别到清晰正面人脸，当前使用居中构图；建议换一张单人正面半身照。' })
          mask = framing.cropMask(mask, crop, dimensions.width, dimensions.height)
        } else {
          mask = await this._segmenter.segment(this._sourceImageData)
        }
        if (this._disposed || photoToken !== this._photoToken) return
        this._portraitMask = mask
        this.setData({ portraitMode: true })
      } catch (error) {
        if (this._disposed || photoToken !== this._photoToken) return
        if (config.portraitBackend === 'ecs') {
          this.setData({ hasImage: false, resultSrc: '' })
          throw new Error(error.message || '高清人像抠图暂不可用，请稍后重试')
        }
        if (error.code === 'NO_PORTRAIT') {
          this.setData({ hasImage: false, resultSrc: '' })
          throw error
        }
        this._segmenter.dispose()
        this._segmenter = null
        this.setData({
          portraitMode: false,
          engineNotice: '当前设备未能启用人像分割，已切换基础换底色；请使用纯色背景照片，或更新微信后重试。'
        })
      }
      if (!this._portraitMask) {
        this._borderColors = processing.estimateBorderColors(
          this._sourceImageData.data, width, height
        )
        this._cutoutWorkspace = processing.createCutoutWorkspace(width, height)
        this._textureMap = processing.buildTextureMap(
          this._sourceImageData.data, width, height
        )
      } else {
        this._borderColors = null
        this._textureMap = null
        this._cutoutWorkspace = null
      }
      // 手动修正的遮罩与照片同尺寸，换照片时连同撤销栈一起重建。
      this._sourceCanvas = sourceCanvas
      this._brushMask = brushMask.createMask(width, height)
      this._maskUndo = []
      this._lastBrushPoint = null
      this.setData({ canUndoBrush: false })

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
      if (!this._disposed && photoToken === this._photoToken) {
        this.setData({ processing: false })
      }
    }
  },

  async renderResult() {
    if (this._disposed || !this._sourceImageData || !this._outputCanvas) return
    const width = config.limits.photoWidth
    const height = config.limits.photoHeight
    const token = (this._renderToken || 0) + 1
    this._renderToken = token
    const selected = this.currentBackground()

    const cutout = this._portraitMask
      ? portrait.applyPortraitMask(this._sourceImageData, this._portraitMask, {
          tolerance: this.data.tolerance,
          featherRadius: this.data.feather,
          edgeCleanup: this.data.edgeCleanup,
          output: this._cutoutImageData.data
        })
      : processing.removeBackground(this._sourceImageData, {
          tolerance: this.data.tolerance,
          feather: true,
          featherRadius: this.data.feather,
          backgroundColors: this._borderColors,
          texture: this._textureMap,
          workspace: this._cutoutWorkspace,
          // 直接写回复用的 ImageData，省掉一次整图拷贝。
          output: this._cutoutImageData.data
        })
    this._cutoutWorkspace = cutout.workspace
    // 手动涂抹的修正叠加在自动结果之上，调容差或换底色都不会丢掉。
    brushMask.applyMask(this._cutoutImageData, this._brushMask)
    this._cutoutContext.putImageData(this._cutoutImageData, 0, 0)

    const outputWidth = this.data.photoWidth
    const outputHeight = this.data.photoHeight
    if (this._outputCanvas.width !== outputWidth || this._outputCanvas.height !== outputHeight) {
      this._outputCanvas.width = outputWidth
      this._outputCanvas.height = outputHeight
    }
    this._outputContext.clearRect(0, 0, outputWidth, outputHeight)
    if (selected && selected.id !== 'transparent') {
      this._outputContext.fillStyle = selected.color
      this._outputContext.fillRect(0, 0, outputWidth, outputHeight)
    }
    const crop = processing.centerCropRect(width, height, outputWidth, outputHeight)
    this._outputContext.drawImage(this._cutoutCanvas,
      crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, outputWidth, outputHeight)

    const resultSrc = await canvasTools.canvasToTempFile(
      this._outputCanvas,
      'png',
      1
    )
    // 拖动滑块会并发多次渲染，只采纳最后一次发起的渲染结果。
    if (this._disposed || token !== this._renderToken) return
    this.setData({
      resultSrc: resultSrc,
      removedPercent: Math.round(
        (cutout.removedPixels / (width * height)) * 100
      )
    })
    // 涂抹画布展示的是抠图结果本身，重算后要同步刷新。
    if (this.data.brushMode) this.drawBrushStage()
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

  onEdgeCleanupChange(event) {
    this.setData({ edgeCleanup: !!event.detail.value })
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
              if (!this._disposed) this.setData({ processing: false })
            }.bind(this)
          )
      }.bind(this),
      180
    )
  },

  currentBackground() {
    const key = this.data.backgroundKey
    const selected = this.data.backgrounds.find(function find(item) {
      return item.id === key
    })
    return selected || null
  },

  toggleBrush() {
    if (this.data.brushMode) {
      this.setData({ brushMode: false })
      return
    }
    if (!this._cutoutImageData || !this._brushMask) return
    // 画布节点要等 setData 渲染完才存在，挂载放在回调里。
    this.setData(
      { brushMode: true },
      function mounted() {
        this.mountBrushCanvas()
      }.bind(this)
    )
  },

  mountBrushCanvas() {
    const query = wx.createSelectorQuery()
    query
      .select('#brushCanvas')
      .fields({ node: true, size: true, rect: true })
      .exec(
        function selected(result) {
          const target = result && result[0]
          if (!target || !target.node) {
            this.setData({ brushMode: false })
            feedback.showError(new Error('修正画布初始化失败'))
            return
          }
          const ratio = this.getPixelRatio()
          const canvas = target.node
          canvas.width = Math.max(1, Math.round(target.width * ratio))
          canvas.height = Math.max(1, Math.round(target.height * ratio))
          this._brushCanvas = canvas
          this._brushContext = canvas.getContext('2d')
          this._pixelRatio = ratio
          // 画布像素 ÷ 照片像素。触摸坐标和笔刷半径都靠它换算。
          this._brushScale = canvas.width / config.limits.photoWidth
          this._brushRect = {
            left: target.left || 0,
            top: target.top || 0
          }
          this._lastBrushPoint = null
          this.drawBrushStage()
        }.bind(this)
      )
  },

  getPixelRatio() {
    if (typeof wx.getWindowInfo === 'function') {
      const info = wx.getWindowInfo()
      if (info && info.pixelRatio) return info.pixelRatio
    }
    const fallback = wx.getSystemInfoSync()
    return (fallback && fallback.pixelRatio) || 1
  },

  drawBrushStage() {
    const canvas = this._brushCanvas
    const context = this._brushContext
    if (!canvas || !context || !this._cutoutCanvas) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    const selected = this.currentBackground()
    if (selected && selected.id !== 'transparent') {
      context.fillStyle = selected.color
      context.fillRect(0, 0, canvas.width, canvas.height)
    }
    context.drawImage(this._cutoutCanvas, 0, 0, canvas.width, canvas.height)
  },

  getBrushPoint(event) {
    if (!this._brushRect || !this._brushScale || !this._pixelRatio) return null
    const touch =
      (event.touches && event.touches[0]) ||
      (event.changedTouches && event.changedTouches[0])
    if (!touch) return null
    const offsetX =
      typeof touch.x === 'number'
        ? touch.x
        : (touch.clientX || touch.pageX || 0) - this._brushRect.left
    const offsetY =
      typeof touch.y === 'number'
        ? touch.y
        : (touch.clientY || touch.pageY || 0) - this._brushRect.top
    // 触点是 CSS 像素，先换成画布像素，再换成照片像素。
    return brushMask.toPhotoPoint(
      offsetX,
      offsetY,
      this._pixelRatio,
      this._brushScale
    )
  },

  onBrushTouchStart(event) {
    if (!this._brushContext) return
    this._strokeSnapshotPushed = false
    this._lastBrushPoint = null
    this.paintBrushAt(event)
  },

  onBrushTouchMove(event) {
    if (!this._brushContext) return
    this.paintBrushAt(event)
  },

  async onBrushTouchEnd() {
    // 只有真实产生涂抹的那一笔才需要重算结果。
    if (!this._strokeSnapshotPushed) return
    this._strokeSnapshotPushed = false
    this._lastBrushPoint = null
    try {
      await this.renderResult()
    } catch (error) {
      feedback.showError(error, '处理失败，请重试')
    }
  },

  paintBrushAt(event) {
    const point = this.getBrushPoint(event)
    if (!point) return
    const radius = this.data.brushSize
    const last = this._lastBrushPoint
    if (last) {
      const distance = Math.hypot(point.x - last.x, point.y - last.y)
      if (distance < radius * 0.25) return
      // 快速划过时沿直线补点，笔迹才不会断成一串圆点。
      const steps = Math.max(1, Math.ceil(distance / (radius * 0.5)))
      for (let step = 1; step <= steps; step += 1) {
        const ratio = step / steps
        this.strokeDab(
          last.x + (point.x - last.x) * ratio,
          last.y + (point.y - last.y) * ratio,
          radius
        )
      }
    } else {
      this.strokeDab(point.x, point.y, radius)
    }
    this._lastBrushPoint = point
  },

  strokeDab(x, y, radius) {
    const value =
      this.data.brushTool === 'restore'
        ? brushMask.MASK_KEEP
        : brushMask.MASK_ERASE
    // 一笔一个撤销点，且必须在涂抹前拍快照，否则撤销会回到涂抹后的状态。
    const pendingSnapshot = !this._strokeSnapshotPushed
    if (pendingSnapshot) {
      this.pushMaskSnapshot()
      this._strokeSnapshotPushed = true
    }
    const changed = brushMask.paintCircle(
      this._brushMask,
      config.limits.photoWidth,
      config.limits.photoHeight,
      x,
      y,
      radius,
      value
    )
    if (!changed) {
      // 这一笔什么都没改，把刚拍的快照退回去，不让撤销按钮空转。
      if (pendingSnapshot) {
        this._maskUndo.pop()
        this._strokeSnapshotPushed = false
      }
      return
    }
    if (!this.data.canUndoBrush) this.setData({ canUndoBrush: true })
    this.drawDab(x, y, radius)
  },

  drawDab(x, y, radius) {
    const canvas = this._brushCanvas
    const context = this._brushContext
    if (!canvas || !context || !this._sourceCanvas) return
    const scale = canvas.width / config.limits.photoWidth
    const brushRadius = Math.max(1, radius * scale)
    context.save()
    context.beginPath()
    context.arc(x * scale, y * scale, brushRadius, 0, Math.PI * 2)
    if (this.data.brushTool === 'restore') {
      // 恢复：把原图对应区域贴回圆里。
      context.clip()
      context.drawImage(this._sourceCanvas, 0, 0, canvas.width, canvas.height)
    } else {
      const selected = this.currentBackground()
      if (selected && selected.id !== 'transparent') {
        context.fillStyle = selected.color
        context.fill()
      } else {
        // 透明底：清出棋盘格。
        context.clip()
        context.clearRect(0, 0, canvas.width, canvas.height)
      }
    }
    context.restore()
  },

  pushMaskSnapshot() {
    if (!this._maskUndo || !this._brushMask) return
    this._maskUndo.push(new Uint8Array(this._brushMask))
    if (this._maskUndo.length > 4) this._maskUndo.shift()
  },

  chooseBrushTool(event) {
    const tool = event.currentTarget.dataset.tool
    if (!tool || tool === this.data.brushTool) return
    this.setData({ brushTool: tool })
  },

  onBrushSizeChange(event) {
    this.setData({ brushSize: Number(event.detail.value) })
  },

  async undoBrush() {
    if (!this._maskUndo || !this._maskUndo.length) return
    this._brushMask.set(this._maskUndo.pop())
    this._strokeSnapshotPushed = false
    this._lastBrushPoint = null
    this.setData({ canUndoBrush: this._maskUndo.length > 0 })
    try {
      await this.renderResult()
    } catch (error) {
      feedback.showError(error, '处理失败，请重试')
    }
  },

  async resetBrush() {
    if (!this._brushMask) return
    brushMask.clearMask(this._brushMask)
    this._maskUndo = []
    this._strokeSnapshotPushed = false
    this._lastBrushPoint = null
    this.setData({ canUndoBrush: false })
    try {
      await this.renderResult()
    } catch (error) {
      feedback.showError(error, '处理失败，请重试')
    }
  },

  async choosePhotoSize(event) {
    if (this.data.processing) return
    const key = event.currentTarget.dataset.key
    const size = this.data.photoSizes.find(function find(item) { return item.id === key })
    if (!size || size.id === this.data.photoSizeKey) return
    this.setData({
      photoSizeKey: size.id, photoSizeLabel: size.label,
      photoWidth: size.width, photoHeight: size.height, processing: true
    })
    try {
      await this.renderResult()
    } catch (error) {
      feedback.showError(error, '切换照片尺寸失败')
    } finally {
      if (!this._disposed) this.setData({ processing: false })
    }
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
          if (!this._disposed) this.setData({ processing: false })
        }.bind(this)
      )
  },

  async saveResult() {
    if (this.data.processing || !this.data.resultSrc) return
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

