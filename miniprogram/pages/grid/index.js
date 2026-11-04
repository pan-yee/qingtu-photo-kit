const config = require('../../config/index')
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
    cells: []
  },

  onUnload() {
    this._gridToken = (this._gridToken || 0) + 1
  },

  async chooseImage() {
    try {
      const files = await media.chooseImages(1)
      if (!files.length) return
      this._sourcePath = files[0].path
      this.setData({
        hasImage: true,
        sourceSrc: files[0].path,
        cells: []
      })
      await this.generateGrid()
    } catch (error) {
      feedback.showError(error, '读取图片失败，请重试')
    }
  },

  async generateGrid() {
    if (!this._sourcePath) return
    const token = (this._gridToken || 0) + 1
    this._gridToken = token
    this.setData({ busy: true })
    try {
      const side = config.limits.gridSide
      const baseCanvas = canvasTools.createCanvas(side, side)
      const baseContext = baseCanvas.getContext('2d')
      baseContext.clearRect(0, 0, side, side)
      const image = await canvasTools.loadImage(
        baseCanvas,
        this._sourcePath
      )
      canvasTools.drawImageCover(
        baseContext,
        image,
        0,
        0,
        side,
        side,
        0
      )

      const rects = processing.getGridRects(side, side, 3, 3, 0)
      const cells = []
      for (let i = 0; i < rects.length; i += 1) {
        const rect = rects[i]
        const cellCanvas = canvasTools.createCanvas(rect.width, rect.height)
        const cellContext = cellCanvas.getContext('2d')
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
        cells.push({
          index: i + 1,
          path: path
        })
      }
      // 重复点击“重新生成”时只采纳最后一次的结果。
      if (token !== this._gridToken) return
      this.setData({ cells: cells })
    } catch (error) {
      if (token === this._gridToken) {
        feedback.showError(error, '生成失败，请重试')
      }
    } finally {
      if (token === this._gridToken) {
        this.setData({ busy: false })
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
    if (this.data.cells.length !== 9) {
      wx.showToast({ title: '请先生成九宫格', icon: 'none' })
      return
    }
    // 连续点击会重复播放激励视频并重复写入相册，这里做一次互斥。
    if (this._saving) return
    this._saving = true
    try {
      const unlocked = await rewarded.unlockHighQuality()
      if (!unlocked) {
        wx.showToast({ title: '完整观看后可保存', icon: 'none' })
        return
      }
      const cells = this.data.cells
      for (let i = 0; i < cells.length; i += 1) {
        wx.showLoading({
          title: '保存 ' + (i + 1) + ' / ' + cells.length,
          mask: true
        })
        await media.saveImage(cells[i].path)
      }
      wx.hideLoading()
      wx.showModal({
        title: '9 张图片已保存',
        content: '已按 1 到 9 的顺序保存到相册，可自行查看和选用。',
        showCancel: false,
        confirmText: '知道了'
      })
    } catch (error) {
      if (!exportImage.isCancelled(error)) {
        feedback.showError(error, '保存失败，请重试')
      }
    } finally {
      wx.hideLoading()
      this._saving = false
    }
  }
})

