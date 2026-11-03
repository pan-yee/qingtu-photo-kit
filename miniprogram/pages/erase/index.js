const config = require('../../config/index')
const canvasTools = require('../../utils/canvas')
const media = require('../../utils/media')
const rewarded = require('../../utils/rewarded')

Page({
  data: {
    hasImage: false,
    busy: false,
    dirty: false,
    brushSize: 44,
    canUndo: false
  },

  onUnload() {
    this._workingData = null
    this._undoStack = null
  },

  async chooseImage() {
    try {
      const files = await media.chooseImages(1)
      if (!files.length) return
      this._sourcePath = files[0].path
      this.setData({ hasImage: true, busy: true, dirty: false })
      wx.nextTick(
        function mountCanvas() {
          this.mountCanvas()
        }.bind(this)
      )
    } catch (error) {
      this.showError(error)
    }
  },

  mountCanvas() {
    const query = wx.createSelectorQuery()
    query
      .select('#eraserCanvas')
      .fields({ node: true, size: true, rect: true })
      .exec(
        function selected(result) {
          const target = result && result[0]
          if (!target || !target.node) {
            this.setData({ busy: false })
            this.showError(new Error('画布初始化失败'))
            return
          }
          this._canvas = target.node
          this._canvasRect = {
            left: target.left || 0,
            top: target.top || 0,
            width: target.width || 1,
            height: target.height || 1
          }
          this.drawSource().finally(
            function done() {
              this.setData({ busy: false })
            }.bind(this)
          )
        }.bind(this)
      )
  },

  async drawSource() {
    const side = config.limits.eraseCanvasSide
    this._canvas.width = side
    this._canvas.height = side
    this._context = this._canvas.getContext('2d')
    this._context.clearRect(0, 0, side, side)
    const image = await canvasTools.loadImage(this._canvas, this._sourcePath)
    canvasTools.drawImageCover(
      this._context,
      image,
      0,
      0,
      side,
      side,
      0
    )
    this._workingData = this._context.getImageData(0, 0, side, side)
    this._undoStack = []
    this.setData({ dirty: false, canUndo: false })
  },

  getCanvasPoint(event) {
    const touch =
      (event.touches && event.touches[0]) ||
      (event.changedTouches && event.changedTouches[0])
    if (!touch) return null
    const canvasX =
      typeof touch.x === 'number'
        ? touch.x
        : (touch.clientX || touch.pageX || 0) - this._canvasRect.left
    const canvasY =
      typeof touch.y === 'number'
        ? touch.y
        : (touch.clientY || touch.pageY || 0) - this._canvasRect.top
    const scale = config.limits.eraseCanvasSide / this._canvasRect.width
    return {
      x: canvasX * scale,
      y: canvasY * scale
    }
  },

  onTouchStart(event) {
    if (!this._context || !this._workingData) return
    this._undoStack.push(
      new Uint8ClampedArray(this._workingData.data)
    )
    if (this._undoStack.length > 4) this._undoStack.shift()
    this._lastRepairPoint = null
    this.repairAt(event)
  },

  onTouchMove(event) {
    this.repairAt(event)
  },

  repairAt(event) {
    const point = this.getCanvasPoint(event)
    if (!point) return
    const radius = this.data.brushSize * 1.7
    if (
      this._lastRepairPoint &&
      Math.hypot(
        point.x - this._lastRepairPoint.x,
        point.y - this._lastRepairPoint.y
      ) <
        Math.max(7, radius * 0.24)
    ) {
      return
    }

    this._lastRepairPoint = point
    this.sampleAndRepair(point.x, point.y, radius)
    if (!this.data.dirty) {
      this.setData({ dirty: true, canUndo: true })
    } else if (!this.data.canUndo) {
      this.setData({ canUndo: true })
    }
  },

  sampleAndRepair(centerX, centerY, radius) {
    const width = this._workingData.width
    const height = this._workingData.height
    const pixels = this._workingData.data
    const cx = Math.round(centerX)
    const cy = Math.round(centerY)
    const outer = radius + 5
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    let count = 0
    const samples = 56

    for (let i = 0; i < samples; i += 1) {
      const angle = (Math.PI * 2 * i) / samples
      const sx = Math.round(cx + Math.cos(angle) * outer)
      const sy = Math.round(cy + Math.sin(angle) * outer)
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue
      const offset = (sy * width + sx) * 4
      r += pixels[offset]
      g += pixels[offset + 1]
      b += pixels[offset + 2]
      a += pixels[offset + 3]
      count += 1
    }

    if (!count) return
    const average = [
      Math.round(r / count),
      Math.round(g / count),
      Math.round(b / count),
      Math.round(a / count)
    ]
    const rInt = Math.ceil(radius)
    const patchSide = rInt * 2 + 1
    const left = Math.max(0, cx - rInt)
    const top = Math.max(0, cy - rInt)
    const right = Math.min(width, cx + rInt + 1)
    const bottom = Math.min(height, cy + rInt + 1)
    const patchWidth = right - left
    const patchHeight = bottom - top
    if (patchWidth <= 0 || patchHeight <= 0) return

    const patch = this._context.createImageData(patchWidth, patchHeight)
    for (let y = 0; y < patchHeight; y += 1) {
      for (let x = 0; x < patchWidth; x += 1) {
        const imageX = left + x
        const imageY = top + y
        const distance = Math.hypot(imageX - cx, imageY - cy)
        if (distance > radius) continue
        const sourceOffset = (imageY * width + imageX) * 4
        const patchOffset = (y * patchWidth + x) * 4
        const feather = Math.min(1, (radius - distance) / (radius * 0.18))
        const blend = Math.max(0, feather)
        const original = [
          pixels[sourceOffset],
          pixels[sourceOffset + 1],
          pixels[sourceOffset + 2],
          pixels[sourceOffset + 3]
        ]
        const output = average.map(function mix(color, index) {
          return Math.round(
            original[index] * (1 - blend) + color * blend
          )
        })
        pixels[sourceOffset] = output[0]
        pixels[sourceOffset + 1] = output[1]
        pixels[sourceOffset + 2] = output[2]
        pixels[sourceOffset + 3] = output[3]
        patch.data[patchOffset] = output[0]
        patch.data[patchOffset + 1] = output[1]
        patch.data[patchOffset + 2] = output[2]
        patch.data[patchOffset + 3] = output[3]
      }
    }
    this._context.putImageData(patch, left, top)
  },

  onBrushChange(event) {
    this.setData({ brushSize: Number(event.detail.value) })
  },

  undo() {
    if (!this._undoStack || !this._undoStack.length) return
    const previous = this._undoStack.pop()
    this._workingData.data.set(previous)
    this._context.putImageData(this._workingData, 0, 0)
    this.setData({
      dirty: this._undoStack.length > 0,
      canUndo: this._undoStack.length > 0
    })
  },

  async reset() {
    if (!this._sourcePath || !this._canvas) return
    this.setData({ busy: true })
    try {
      await this.drawSource()
    } catch (error) {
      this.showError(error)
    } finally {
      this.setData({ busy: false })
    }
  },

  async saveResult() {
    if (!this.data.dirty || !this._canvas) {
      wx.showToast({ title: '先涂抹需要擦除的区域', icon: 'none' })
      return
    }
    try {
      const unlocked = await rewarded.unlockHighQuality()
      if (!unlocked) {
        wx.showToast({ title: '完整观看后可保存', icon: 'none' })
        return
      }
      this.setData({ busy: true })
      const path = await canvasTools.canvasToTempFile(
        this._canvas,
        'png',
        1
      )
      await media.saveImage(path)
      wx.showToast({ title: '已保存到相册', icon: 'success' })
    } catch (error) {
      if (!/cancel/i.test((error && error.errMsg) || '')) {
        this.showError(error)
      }
    } finally {
      this.setData({ busy: false })
    }
  },

  showError(error) {
    console.error(error)
    wx.showToast({
      title: (error && error.message) || '处理失败，请重试',
      icon: 'none'
    })
  }
})

