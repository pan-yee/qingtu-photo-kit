const config = require('../../config/index')
const canvasTools = require('../../utils/canvas')
const media = require('../../utils/media')
const rewarded = require('../../utils/rewarded')

function clampChannel(value) {
  return Math.min(255, Math.max(0, Math.round(value)))
}

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

  collectRingSamples(centerX, centerY, radius) {
    const width = this._workingData.width
    const height = this._workingData.height
    const pixels = this._workingData.data
    const outer = radius + 5
    const points = []
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    const samples = 64

    for (let i = 0; i < samples; i += 1) {
      const angle = (Math.PI * 2 * i) / samples
      const x = Math.round(centerX + Math.cos(angle) * outer)
      const y = Math.round(centerY + Math.sin(angle) * outer)
      if (x < 0 || y < 0 || x >= width || y >= height) continue
      const offset = (y * width + x) * 4
      const point = {
        x: x,
        y: y,
        r: pixels[offset],
        g: pixels[offset + 1],
        b: pixels[offset + 2],
        a: pixels[offset + 3]
      }
      points.push(point)
      r += point.r
      g += point.g
      b += point.b
      a += point.a
    }

    const count = Math.max(1, points.length)
    return {
      points: points,
      average: [
        Math.round(r / count),
        Math.round(g / count),
        Math.round(b / count),
        Math.round(a / count)
      ]
    }
  },

  fitPlane(points, channel) {
    const count = points.length
    if (count < 8) return null

    let sx = 0
    let sy = 0
    let sxx = 0
    let syy = 0
    let sxy = 0
    let sv = 0
    let sxv = 0
    let syv = 0

    for (let i = 0; i < count; i += 1) {
      const point = points[i]
      const x = point.x
      const y = point.y
      const value = point[channel]
      sx += x
      sy += y
      sxx += x * x
      syy += y * y
      sxy += x * y
      sv += value
      sxv += x * value
      syv += y * value
    }

    const determinant =
      sxx * (syy * count - sy * sy) -
      sxy * (sxy * count - sx * sy) +
      sx * (sxy * sy - sx * syy)
    if (Math.abs(determinant) < 1e-6) return null

    const inverse00 = (syy * count - sy * sy) / determinant
    const inverse01 = (sx * sy - sxy * count) / determinant
    const inverse02 = (sxy * sy - sx * syy) / determinant
    const inverse10 = inverse01
    const inverse11 = (sxx * count - sx * sx) / determinant
    const inverse12 = (sxy * sx - sxx * sy) / determinant
    const inverse20 = inverse02
    const inverse21 = inverse12
    const inverse22 = (sxx * syy - sxy * sxy) / determinant

    return [
      inverse00 * sxv + inverse01 * syv + inverse02 * sv,
      inverse10 * sxv + inverse11 * syv + inverse12 * sv,
      inverse20 * sxv + inverse21 * syv + inverse22 * sv
    ]
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
    const ring = this.collectRingSamples(cx, cy, radius)
    if (!ring.points.length) return
    const average = ring.average
    const redPlane = this.fitPlane(ring.points, 'r')
    const greenPlane = this.fitPlane(ring.points, 'g')
    const bluePlane = this.fitPlane(ring.points, 'b')
    const rInt = Math.ceil(radius)
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
        const restored = [
          redPlane
            ? clampChannel(
                redPlane[0] * imageX + redPlane[1] * imageY + redPlane[2]
              )
            : average[0],
          greenPlane
            ? clampChannel(
                greenPlane[0] * imageX +
                  greenPlane[1] * imageY +
                  greenPlane[2]
              )
            : average[1],
          bluePlane
            ? clampChannel(
                bluePlane[0] * imageX + bluePlane[1] * imageY + bluePlane[2]
              )
            : average[2]
        ]
        const original = [
          pixels[sourceOffset],
          pixels[sourceOffset + 1],
          pixels[sourceOffset + 2],
          pixels[sourceOffset + 3]
        ]
        const output = [
          Math.round(original[0] * (1 - blend) + restored[0] * blend),
          Math.round(original[1] * (1 - blend) + restored[1] * blend),
          Math.round(original[2] * (1 - blend) + restored[2] * blend),
          original[3]
        ]
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

