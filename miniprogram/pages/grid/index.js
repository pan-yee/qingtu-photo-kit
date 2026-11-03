const config = require('../../config/index')
const canvasTools = require('../../utils/canvas')
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
      this.showError(error)
    }
  },

  async generateGrid() {
    if (!this._sourcePath) return
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
      this.setData({ cells: cells })
    } catch (error) {
      this.showError(error)
    } finally {
      this.setData({ busy: false })
    }
  },

  previewCell(event) {
    const index = Number(event.currentTarget.dataset.index)
    const urls = this.data.cells.map(function mapCell(item) {
      return item.path
    })
    media.previewImage(urls[index], urls)
  },

  async saveAll() {
    if (this.data.cells.length !== 9) {
      wx.showToast({ title: '请先生成九宫格', icon: 'none' })
      return
    }
    try {
      const unlocked = await rewarded.unlockHighQuality()
      if (!unlocked) {
        wx.showToast({ title: '完整观看后可保存', icon: 'none' })
        return
      }
      for (let i = 0; i < this.data.cells.length; i += 1) {
        wx.showLoading({
          title: '保存 ' + (i + 1) + ' / 9',
          mask: true
        })
        await media.saveImage(this.data.cells[i].path)
      }
      wx.hideLoading()
      wx.showModal({
        title: '9 张图片已保存',
        content: '已按 1 到 9 的顺序保存到相册，发布时请按顺序选择。',
        showCancel: false,
        confirmText: '知道了'
      })
    } catch (error) {
      wx.hideLoading()
      if (!/cancel/i.test((error && error.errMsg) || '')) {
        this.showError(error)
      }
    }
  },

  showError(error) {
    console.error(error)
    wx.showToast({
      title: (error && error.message) || '生成失败，请重试',
      icon: 'none'
    })
  }
})

