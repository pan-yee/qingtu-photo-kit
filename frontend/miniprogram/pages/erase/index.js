const config = require('../../config/index')
const canvasTools = require('../../utils/canvas')
const exportImage = require('../../utils/export-image')
const feedback = require('../../utils/feedback')
const media = require('../../utils/media')
const patchRepair = require('../../utils/patch-repair')

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
    this._context = null
    this._canvas = null
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
      feedback.showError(error, '读取图片失败，请重试')
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
            feedback.showError(new Error('画布初始化失败'))
            return
          }
          this._canvas = target.node
          this._canvasRect = {
            left: target.left || 0,
            top: target.top || 0,
            width: target.width || 1,
            height: target.height || 1
          }
          this.drawSource()
            .catch(function failed(error) {
              feedback.showError(error, '图片加载失败，请换一张重试')
            })
            .finally(
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
    if (!this._canvasRect) return null
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
    this._strokeSnapshotPushed = false
    this._lastRepairPoint = null
    this.repairAt(event)
  },

  onTouchMove(event) {
    if (!this._context || !this._workingData) return
    this.repairAt(event)
  },

  pushUndoSnapshot() {
    this._undoStack.push(new Uint8ClampedArray(this._workingData.data))
    if (this._undoStack.length > 4) this._undoStack.shift()
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

    const patch = patchRepair.buildRepairPatch(
      this._workingData.data,
      this._workingData.width,
      this._workingData.height,
      point.x,
      point.y,
      radius
    )
    if (!patch) return

    this._lastRepairPoint = point
    // 只有真正产生修复时才记录撤销点，避免无效点按占满撤销栈。
    if (!this._strokeSnapshotPushed) {
      this.pushUndoSnapshot()
      this._strokeSnapshotPushed = true
    }
    this.applyPatch(patch)

    if (!this.data.dirty) {
      this.setData({ dirty: true, canUndo: true })
    } else if (!this.data.canUndo) {
      this.setData({ canUndo: true })
    }
  },

  applyPatch(patch) {
    const working = this._workingData
    const rowBytes = patch.width * 4
    for (let y = 0; y < patch.height; y += 1) {
      const targetOffset = ((patch.top + y) * working.width + patch.left) * 4
      working.data.set(
        patch.data.subarray(y * rowBytes, (y + 1) * rowBytes),
        targetOffset
      )
    }
    const patchImage = this._context.createImageData(
      patch.width,
      patch.height
    )
    patchImage.data.set(patch.data)
    this._context.putImageData(patchImage, patch.left, patch.top)
  },

  onBrushChange(event) {
    this.setData({ brushSize: Number(event.detail.value) })
  },

  undo() {
    if (!this._undoStack || !this._undoStack.length) return
    const previous = this._undoStack.pop()
    this._workingData.data.set(previous)
    this._context.putImageData(this._workingData, 0, 0)
    this._strokeSnapshotPushed = false
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
      feedback.showError(error, '处理失败，请重试')
    } finally {
      this.setData({ busy: false })
    }
  },

  async saveResult() {
    if (!this.data.dirty || !this._canvas) {
      wx.showToast({ title: '先涂抹需要擦除的区域', icon: 'none' })
      return
    }
    this.setData({ busy: true })
    try {
      const path = await canvasTools.canvasToTempFile(
        this._canvas,
        'png',
        1
      )
      await exportImage.saveWithReward(path)
    } catch (error) {
      if (!exportImage.isCancelled(error)) {
        feedback.showError(error, '处理失败，请重试')
      }
    } finally {
      this.setData({ busy: false })
    }
  }
})

