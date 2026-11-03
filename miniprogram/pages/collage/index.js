const canvasTools = require('../../utils/canvas')
const media = require('../../utils/media')
const processing = require('../../utils/image-processing')
const rewarded = require('../../utils/rewarded')

Page({
  data: {
    images: [],
    template: 'grid',
    busy: false,
    resultSrc: '',
    outputLabel: '1200 × 1200',
    templates: [
      { id: 'grid', label: '宫格', note: '整齐留白', size: '1200 × 1200' },
      { id: 'hero', label: '海报', note: '主次分明', size: '1200 × 1600' },
      { id: 'vertical', label: '竖版', note: '上下排列', size: '1080 × 1440' },
      { id: 'horizontal', label: '横版', note: '左右排列', size: '1440 × 1080' }
    ]
  },

  async addImages() {
    const remaining = 9 - this.data.images.length
    if (remaining <= 0) {
      wx.showToast({ title: '最多选择 9 张图片', icon: 'none' })
      return
    }
    try {
      const files = await media.chooseImages(remaining)
      if (!files.length) return
      const stamp = Date.now()
      const additions = files.map(function mapFile(file, index) {
        return {
          key: stamp + '-' + index,
          path: file.path,
          width: file.width || 0,
          height: file.height || 0
        }
      })
      this.setData({
        images: this.data.images.concat(additions),
        resultSrc: ''
      })
    } catch (error) {
      this.showError(error)
    }
  },

  selectTemplate(event) {
    const id = event.currentTarget.dataset.id
    if (!id || id === this.data.template) return
    const selected = this.data.templates.find(function find(item) {
      return item.id === id
    })
    this.setData({
      template: id,
      resultSrc: '',
      outputLabel: selected ? selected.size : '高清输出'
    })
  },

  removeImage(event) {
    const index = Number(event.currentTarget.dataset.index)
    const images = this.data.images.slice()
    images.splice(index, 1)
    this.setData({ images: images, resultSrc: '' })
  },

  clearImages() {
    this.setData({ images: [], resultSrc: '' })
  },

  getOutputSize(template) {
    const sizes = {
      grid: [1200, 1200],
      hero: [1200, 1600],
      vertical: [1080, 1440],
      horizontal: [1440, 1080]
    }
    return sizes[template] || sizes.grid
  },

  async generateCollage() {
    const images = this.data.images
    if (!images.length) {
      wx.showToast({ title: '请先选择图片', icon: 'none' })
      return
    }
    this.setData({ busy: true })
    try {
      const size = this.getOutputSize(this.data.template)
      const width = size[0]
      const height = size[1]
      const canvas = canvasTools.createCanvas(width, height)
      const context = canvas.getContext('2d')
      context.fillStyle = '#f8f6f0'
      context.fillRect(0, 0, width, height)

      const cells = processing.getCollageLayout(
        this.data.template,
        images.length,
        width,
        height,
        20,
        10
      )
      for (let i = 0; i < images.length && i < cells.length; i += 1) {
        const image = await canvasTools.loadImage(canvas, images[i].path)
        const cell = cells[i]
        canvasTools.drawImageCover(
          context,
          image,
          cell.x,
          cell.y,
          cell.width,
          cell.height,
          12
        )
      }
      const path = await canvasTools.canvasToTempFile(
        canvas,
        'jpg',
        0.94
      )
      this._resultPath = path
      this.setData({ resultSrc: path })
    } catch (error) {
      this.showError(error)
    } finally {
      this.setData({ busy: false })
    }
  },

  previewResult() {
    if (!this.data.resultSrc) return
    media.previewImage(this.data.resultSrc)
  },

  async saveResult() {
    if (!this.data.resultSrc) {
      wx.showToast({ title: '请先生成拼接图', icon: 'none' })
      return
    }
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

  showError(error) {
    console.error(error)
    wx.showToast({
      title: (error && error.message) || '生成失败，请重试',
      icon: 'none'
    })
  }
})

