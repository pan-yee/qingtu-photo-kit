const layout = require('../../utils/photo-layout')
const canvasTools = require('../../utils/canvas')
const exportImage = require('../../utils/export-image')
const feedback = require('../../utils/feedback')
const media = require('../../utils/media')
const processing = require('../../utils/image-processing')

Page({
  data: {
    images: [],
    template: 'grid',
    fit: 'contain',
    busy: false,
    resultSrc: '',
    outputLabel: '1200 × 1200',
    templates: [{
        id: 'grid',
        label: '宫格',
        note: '整齐留白',
        size: '1200 × 1200'
      },
      {
        id: 'hero',
        label: '海报',
        note: '主次分明',
        size: '1200 × 1600'
      },
      {
        id: 'vertical',
        label: '竖版',
        note: '上下排列',
        size: '1080 × 1440'
      },
      {
        id: 'horizontal',
        label: '横版',
        note: '左右排列',
        size: '1440 × 1080'
      }
    ]
  },

  onUnload() {
    this._disposed = true;
    this.invalidate()
  },

  invalidate() {
    this._generation = (this._generation || 0) + 1
    if (!this._disposed) this.setData({
      resultSrc: '',
      busy: false
    })
  },

  selectFit(event) {
    const fit = event.currentTarget.dataset.fit
    if (!['contain', 'cover'].includes(fit) || this.data.fit === fit) return
    this.invalidate()
    this.setData({
      fit
    })
  },

  moveImage(event) {
    const index = Number(event.currentTarget.dataset.index)
    const direction = Number(event.currentTarget.dataset.direction)
    const target = index + direction
    if (!Number.isInteger(index) || ![-1, 1].includes(direction) || index < 0 || target < 0 || index >= this.data.images.length || target >= this.data.images.length) return
    const images = this.data.images.slice();
    [images[index], images[target]] = [images[target], images[index]]
    this.invalidate()
    this.setData({
      images
    })
  },

  async addImages() {
    if (this._choosing) return
    this._choosing = true
    try {
      await this.pickImages()
    } finally {
      this._choosing = false
    }
  },

  async pickImages() {
    const remaining = 9 - this.data.images.length
    if (remaining <= 0) {
      wx.showToast({
        title: '最多选择 9 张图片',
        icon: 'none'
      })
      return
    }
    try {
      const files = await media.chooseImages(remaining)
      if (!files.length || this._disposed) return
      const stamp = Date.now()
      const additions = files.map(function mapFile(file, index) {
        return {
          key: stamp + '-' + index,
          path: file.path,
          width: file.width || 0,
          height: file.height || 0
        }
      })
      this.invalidate()
      this.setData({
        images: this.data.images.concat(additions),
        resultSrc: ''
      })
    } catch (error) {
      if (!this._disposed) feedback.showError(error, '读取图片失败，请重试')
    }
  },

  selectTemplate(event) {
    const id = event.currentTarget.dataset.id
    if (!id || id === this.data.template) return
    const selected = this.data.templates.find(function find(item) {
      return item.id === id
    })
    if (!selected) return
    this.invalidate()
    this.setData({
      template: id,
      resultSrc: '',
      outputLabel: selected ? selected.size : '高清输出'
    })
  },

  removeImage(event) {
    const index = Number(event.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index < 0 || index >= this.data.images.length) return
    const images = this.data.images.slice()
    images.splice(index, 1)
    this.invalidate()
    this.setData({
      images: images,
      resultSrc: ''
    })
  },

  clearImages() {
    this.invalidate()
    this.setData({
      images: [],
      resultSrc: ''
    })
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
    const images = this.data.images.slice()
    if (this.data.busy) return
    if (!images.length) {
      wx.showToast({
        title: '请先选择图片',
        icon: 'none'
      })
      return
    }
    const token = (this._generation || 0) + 1
    this._generation = token
    const current = () => !this._disposed && token === this._generation
    const template = this.data.template,
      fit = this.data.fit
    let canvas
    this.setData({
      busy: true,
      resultSrc: ''
    })
    try {
      const size = this.getOutputSize(template)
      const width = size[0]
      const height = size[1]
      canvas = canvasTools.createCanvas(width, height)
      const context = canvas.getContext('2d')
      context.fillStyle = '#f8f6f0'
      context.fillRect(0, 0, width, height)

      const cells = processing.getCollageLayout(
        template,
        images.length,
        width,
        height,
        20,
        10
      )
      for (let i = 0; i < images.length && i < cells.length; i += 1) {
        const image = await canvasTools.loadImage(canvas, images[i].path)
        const cell = cells[i]
        if (!current()) return
        layout.draw(context, image, cell.x, cell.y, cell.width, cell.height, fit)
      }
      const path = await canvasTools.canvasToTempFile(
        canvas,
        'jpg',
        0.94
      )
      if (!current()) return
      this.setData({
        resultSrc: path
      })
    } catch (error) {
      if (current()) feedback.showError(error, '生成失败，请重试')
    } finally {
      if (canvas) {
        canvas.width = 1;
        canvas.height = 1
      }
      if (current()) this.setData({
        busy: false
      })
    }
  },

  previewResult() {
    if (this.data.busy || !this.data.resultSrc) return
    media.previewImage(this.data.resultSrc)
  },

  async saveResult() {
    if (this.data.busy || !this.data.resultSrc) {
      wx.showToast({
        title: '请先生成拼接图',
        icon: 'none'
      })
      return
    }
    try {
      await exportImage.saveWithReward(this.data.resultSrc)
    } catch (error) {
      if (!exportImage.isCancelled(error)) {
        feedback.showError(error, '保存失败，请重试')
      }
    }
  }
})
