const layout = require('../../utils/photo-layout')
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
    canUndo: false,
    canRedo: false,
    comparing: false,
    canvasWidth: 100,
    canvasHeight: 100,
    outputWidth: 0,
    outputHeight: 0
  },

  onHide() {
    this.endCompare();
    this.onTouchEnd()
  },

  onUnload() {
    this._disposed = true
    this._loadToken = (this._loadToken || 0) + 1
    this._originalData = null
    this._redoStack = null
    this._workingData = null
    this._undoStack = null
    this._context = null
    this._canvas = null
  },

  async chooseImage() {
    if (this.data.busy || this._choosing) return
    this._choosing = true
    try {
      const files = await media.chooseImages(1)
      if (!files.length || this._disposed) return
      const info = await media.getImageInfo(files[0].path)
      if (this._disposed) return
      this._size = layout.fitInside(info.width, info.height, config.limits.eraseCanvasSide)
      const longest = Math.max(this._size.width, this._size.height)
      this._sourcePath = files[0].path
      this.setData({
        hasImage: true,
        busy: true,
        dirty: false,
        comparing: false,
        canvasWidth: this._size.width / longest * 100,
        canvasHeight: this._size.height / longest * 100,
        outputWidth: this._size.width,
        outputHeight: this._size.height
      })
      wx.nextTick(
        function mountCanvas() {
          if (!this._disposed) this.mountCanvas()
        }.bind(this)
      )
    } catch (error) {
      if (!this._disposed) feedback.showError(error, '读取图片失败，请重试')
    } finally {
      this._choosing = false
    }
  },

  mountCanvas() {
    const query = wx.createSelectorQuery()
    query
      .select('#eraserCanvas')
      .fields({
        node: true,
        size: true,
        rect: true
      })
      .exec(
        function selected(result) {
          if (this._disposed) return
          const target = result && result[0]
          if (!target || !target.node) {
            if (!this._disposed) this.setData({
              busy: false
            })
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
            .catch(error => {
              if (!this._disposed) feedback.showError(error, '图片加载失败，请换一张重试')
            })
            .finally(
              function done() {
                if (!this._disposed) this.setData({
                  busy: false
                })
              }.bind(this)
            )
        }.bind(this)
      )
  },

  async drawSource() {
    const token = (this._loadToken || 0) + 1
    this._loadToken = token
    const canvas = this._canvas,
      size = this._size
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d')
    const image = await canvasTools.loadImage(canvas, this._sourcePath)
    if (this._disposed || token !== this._loadToken) return
    context.clearRect(0, 0, size.width, size.height)
    context.drawImage(image, 0, 0, size.width, size.height)
    this._context = context
    this._workingData = context.getImageData(0, 0, size.width, size.height)
    this._originalData = new Uint8ClampedArray(this._workingData.data)
    this._undoStack = []
    this._redoStack = []
    this._revision = 0
    this._nextRevision = 0
    this.onTouchEnd()
    this.updateHistory()
  },

  updateHistory() {
    this.setData({
      dirty: this._revision !== 0,
      canUndo: this._undoStack.length > 0,
      canRedo: this._redoStack.length > 0
    })
  },

  startCompare() {
    if (this.data.busy || !this._workingData || this.data.comparing) return
    const original = this._context.createImageData(this._workingData.width, this._workingData.height)
    original.data.set(this._originalData)
    this._context.putImageData(original, 0, 0)
    this.onTouchEnd()
    this.setData({
      comparing: true
    })
  },

  endCompare() {
    if (!this.data.comparing || !this._context || this._disposed) return
    this._context.putImageData(this._workingData, 0, 0)
    this.setData({
      comparing: false
    })
  },

  getCanvasPoint(event) {
    if (!this._canvasRect) return null
    const touch =
      (event.touches && event.touches[0]) ||
      (event.changedTouches && event.changedTouches[0])
    if (!touch) return null
    const canvasX =
      typeof touch.x === 'number' ?
      touch.x :
      (touch.clientX || touch.pageX || 0) - this._canvasRect.left
    const canvasY =
      typeof touch.y === 'number' ?
      touch.y :
      (touch.clientY || touch.pageY || 0) - this._canvasRect.top
    const scaleX = this._canvas.width / this._canvasRect.width
    const scaleY = this._canvas.height / this._canvasRect.height
    return {
      x: canvasX * scaleX,
      y: canvasY * scaleY
    }
  },

  onTouchStart(event) {
    if (this.data.busy || this.data.comparing || this._disposed || !this._context || !this._workingData) return
    this._strokeActive = true
    this._strokeSnapshotPushed = false
    this._lastRepairPoint = null
    this.repairAt(event)
  },

  onTouchMove(event) {
    if (!this._strokeActive) return
    if (this.data.busy || this.data.comparing || this._disposed || !this._context || !this._workingData) return
    this.repairAt(event)
  },

  onTouchEnd() {
    this._strokeActive = false
    this._strokeSnapshotPushed = false
    this._lastRepairPoint = null
  },

  pushUndoSnapshot() {
    this._undoStack.push({
      data: new Uint8ClampedArray(this._workingData.data),
      revision: this._revision
    })
    this._redoStack = []
    this._revision = ++this._nextRevision
    if (this._undoStack.length > 4) this._undoStack.shift()
  },

  getBrushRadius() {
    return Math.max(1, Math.min(Math.min(this._workingData.width, this._workingData.height) / 3, this.data.brushSize / 2 * this._canvas.width / this._canvasRect.width))
  },

  repairAt(event) {
    const point = this.getCanvasPoint(event)
    if (!point) return
    const radius = this.getBrushRadius(),
      previous = this._lastRepairPoint
    if (previous) {
      const distance = Math.hypot(point.x - previous.x, point.y - previous.y)
      const steps = Math.min(12, Math.max(1, Math.ceil(distance / Math.max(2, radius * .5))))
      for (let i = 1; i <= steps; i += 1) {
        this.repairPoint({
          x: previous.x + (point.x - previous.x) * i / steps,
          y: previous.y + (point.y - previous.y) * i / steps
        }, radius)
      }
    } else this.repairPoint(point, radius)
  },

  repairPoint(point, radius) {
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

    this.updateHistory()
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
    this.setData({
      brushSize: Number(event.detail.value)
    })
  },

  restoreHistory(from, to) {
    if (this.data.busy || this.data.comparing || this._disposed || !from || !from.length) return
    to.push({
      data: new Uint8ClampedArray(this._workingData.data),
      revision: this._revision
    })
    const previous = from.pop()
    this._workingData.data.set(previous.data)
    this._revision = previous.revision
    this._context.putImageData(this._workingData, 0, 0)
    this.onTouchEnd()
    this.updateHistory()
  },

  undo() {
    this.restoreHistory(this._undoStack, this._redoStack)
  },
  redo() {
    this.restoreHistory(this._redoStack, this._undoStack)
  },

  async reset() {
    if (this.data.busy || this.data.comparing || !this._sourcePath || !this._canvas) return
    this.setData({
      busy: true
    })
    try {
      await this.drawSource()
    } catch (error) {
      if (!this._disposed) feedback.showError(error, '处理失败，请重试')
    } finally {
      if (!this._disposed) this.setData({
        busy: false
      })
    }
  },

  async saveResult() {
    if (this.data.busy || this.data.comparing || this._disposed) return
    this.onTouchEnd()
    if (!this.data.dirty || !this._canvas) {
      wx.showToast({
        title: '先涂抹需要擦除的区域',
        icon: 'none'
      })
      return
    }
    this.setData({
      busy: true
    })
    try {
      const path = await canvasTools.canvasToTempFile(
        this._canvas,
        'png',
        1
      )
      if (!this._disposed) await exportImage.saveWithReward(path)
    } catch (error) {
      if (!this._disposed && !exportImage.isCancelled(error)) {
        if (!this._disposed) feedback.showError(error, '处理失败，请重试')
      }
    } finally {
      if (!this._disposed) this.setData({
        busy: false
      })
    }
  }
})
