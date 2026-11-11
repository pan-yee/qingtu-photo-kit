const layout = require('../../utils/photo-layout')
const config = require('../../config/index')
const contentSecurity = require('../../utils/content-security')
const canvasTools = require('../../utils/canvas')
const exportImage = require('../../utils/export-image')
const feedback = require('../../utils/feedback')
const media = require('../../utils/media')
const processing = require('../../utils/image-processing')
const rewarded = require('../../utils/rewarded')

Page({
  data: {
    hasImage: false,
    busy: false,
    sourceSrc: '',
    fit: 'contain',
    position: 50,
    progress: 0,
    saving: false,
    savedCount: 0,
    cells: []
  },

  selectFit(event) {
    if (this._saving) return
    const fit = event.currentTarget.dataset.fit
    if (!['contain', 'cover'].includes(fit) || fit === this.data.fit) return
    this.setData({
      fit
    })
    this.generateGrid()
  },

  changePosition(event) {
    if (this._saving) return
    const value = Number(event.detail.value)
    if (!Number.isFinite(value)) return
    this.setData({
      position: Math.max(0, Math.min(100, value))
    })
    this.generateGrid()
  },

  onUnload() {
    this._disposed = true
    this._gridToken = (this._gridToken || 0) + 1
  },

  async chooseImage() {
    if (this._saving || this._choosing) return
    this._choosing = true
    try {
      const files = await media.chooseImages(1)
      if (!files.length || this._disposed) return
      this._sourcePath = files[0].path
      this.setData({
        hasImage: true,
        sourceSrc: files[0].path,
        cells: []
      })
      await this.generateGrid()
    } catch (error) {
      if (!this._disposed) feedback.showError(error, '读取图片失败，请重试')
    } finally {
      this._choosing = false
    }
  },

  async generateGrid() {
    if (!this._sourcePath || this._saving || this._disposed) return
    const token = (this._gridToken || 0) + 1
    this._gridToken = token
    const current = () => !this._disposed && token === this._gridToken
    const source = this._sourcePath,
      fit = this.data.fit,
      position = this.data.position / 100
    this._savedCount = 0
    let baseCanvas, cellCanvas
    this.setData({
      busy: true,
      cells: [],
      progress: 0,
      savedCount: 0
    })
    try {
      const side = config.limits.gridSide
      baseCanvas = canvasTools.createCanvas(side, side)
      const baseContext = baseCanvas.getContext('2d')
      baseContext.clearRect(0, 0, side, side)
      const image = await canvasTools.loadImage(
        baseCanvas,
        source
      )
      if (!current()) return
      baseContext.fillStyle = '#ffffff'
      baseContext.fillRect(0, 0, side, side)
      layout.draw(baseContext, image, 0, 0, side, side, fit, position)

      const rects = processing.getGridRects(side, side, 3, 3, 0)
      const cells = []
      cellCanvas = canvasTools.createCanvas(rects[0].width, rects[0].height)
      const cellContext = cellCanvas.getContext('2d')
      for (let i = 0; i < rects.length; i += 1) {
        const rect = rects[i]
        if (!current()) return
        cellContext.clearRect(0, 0, rect.width, rect.height)
        cellContext.drawImage(
          baseCanvas,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          0,
          0,
          rect.width,
          rect.height
        )
        const path = await canvasTools.canvasToTempFile(
          cellCanvas,
          'jpg',
          0.94
        )
        if (!current()) return
        this.setData({
          progress: i + 1
        })
        cells.push({
          index: i + 1,
          path: path
        })
      }
      // 重复点击“重新生成”时只采纳最后一次的结果。
      if (!current()) return
      this.setData({
        cells: cells
      })
    } catch (error) {
      if (current()) {
        feedback.showError(error, '生成失败，请重试')
      }
    } finally {
      if (cellCanvas) {
        cellCanvas.width = 1;
        cellCanvas.height = 1
      }
      if (baseCanvas) {
        baseCanvas.width = 1;
        baseCanvas.height = 1
      }
      if (current()) {
        this.setData({
          busy: false
        })
      }
    }
  },

  previewCell(event) {
    const index = Number(event.currentTarget.dataset.index)
    const urls = this.data.cells.map(function mapCell(item) {
      return item.path
    })
    if (!urls.length) return
    const safeIndex = Math.min(Math.max(index || 0, 0), urls.length - 1)
    media.previewImage(urls[safeIndex], urls)
  },

  async saveAll() {
    if (this.data.busy || this._disposed) return
    if (this.data.cells.length !== 9) {
      wx.showToast({
        title: '请先生成九宫格',
        icon: 'none'
      })
      return
    }
    // 连续点击会重复播放激励视频并重复写入相册，这里做一次互斥。
    if (this._saving) return
    this._saving = true
    this.setData({
      saving: true
    })
    try {
      const cells = this.data.cells.slice()
      for (let i = 0; i < cells.length; i += 1) await contentSecurity.ensureSafe(cells[i].path)
      if (this._disposed) return
      const unlocked = this._savedCount > 0 || await rewarded.unlockHighQuality()
      if (!unlocked) {
        wx.showToast({
          title: '完整观看后可保存',
          icon: 'none'
        })
        return
      }
      for (let i = this._savedCount || 0; i < cells.length; i += 1) {
        if (this._disposed) return
        wx.showLoading({
          title: '保存 ' + (i + 1) + ' / ' + cells.length,
          mask: true
        })
        await media.saveImage(cells[i].path)
        this._savedCount = i + 1
        if (!this._disposed) this.setData({
          savedCount: i + 1
        })
      }
      this._savedCount = 0
      if (!this._disposed) this.setData({
        savedCount: 0
      })
      wx.hideLoading()
      if (this._disposed) return
      wx.showModal({
        title: '9 张图片已保存',
        content: '已按 1 到 9 的顺序保存到相册，可自行查看和选用。',
        showCancel: false,
        confirmText: '知道了'
      })
    } catch (error) {
      if (!this._disposed && !exportImage.isCancelled(error)) {
        if (this._savedCount > 0) wx.showModal({
          title: '保存中断',
          content: '已保存 ' + this._savedCount + ' 张，点击继续保存可从下一张接着保存。',
          showCancel: false
        })
        else feedback.showError(error, '保存失败，请重试')
      }
    } finally {
      wx.hideLoading()
      this._saving = false
      if (!this._disposed) this.setData({
        saving: false
      })
    }
  }
})
