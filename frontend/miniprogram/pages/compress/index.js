const config = require('../../config/index')
const contentSecurity = require('../../utils/content-security')
const canvasTools = require('../../utils/canvas')
const layout = require('../../utils/photo-layout')
const exportImage = require('../../utils/export-image')
const feedback = require('../../utils/feedback')
const media = require('../../utils/media')
const processing = require('../../utils/image-processing')

Page({
  data: {
    hasImage: false,
    busy: false,
    sourceSrc: '',
    resultSrc: '',
    sourceSizeText: '—',
    resultSizeText: '—',
    savedPercent: 0,
    width: 0,
    height: 0,
    outputWidth: 0,
    outputHeight: 0,
    resultNotice: '',
    preset: 'balanced',
    format: 'auto',
    formats: [{
      id: 'auto',
      label: '自动',
      note: 'PNG 保留透明'
    }, {
      id: 'jpg',
      label: 'JPG',
      note: '透明区域转白底'
    }, {
      id: 'png',
      label: 'PNG',
      note: '保留透明度'
    }],
    presets: [{
        id: 'high',
        label: '高清',
        note: '1600px',
        quality: 90,
        maxSide: 1600
      },
      {
        id: 'balanced',
        label: '均衡',
        note: '1280px',
        quality: 82,
        maxSide: 1280
      },
      {
        id: 'light',
        label: '轻量',
        note: '720px',
        quality: 64,
        maxSide: 720
      }
    ]
  },
  onUnload() {
    this._disposed = true;
    this._compressToken = (this._compressToken || 0) + 1
  },
  async chooseImage() {
    if (this._choosing) return
    this._choosing = true
    try {
      const files = await media.chooseImages(1);
      if (files.length && !this._disposed) await this.prepareImage(files[0])
    } catch (error) {
      if (!this._disposed) feedback.showError(error, '读取图片失败，请重试')
    } finally {
      this._choosing = false
    }
  },
  async prepareImage(file) {
    const token = (this._compressToken || 0) + 1;
    this._compressToken = token
    this.setData({
      busy: true,
      resultSrc: '',
      resultSizeText: '—',
      savedPercent: 0,
      resultNotice: ''
    })
    try {
      const [info, stat] = await Promise.all([media.getImageInfo(file.path), media.getFileInfo(file.path)])
      if (this._disposed || token !== this._compressToken) return
      this._sourcePath = file.path;
      this._sourceWidth = info.width;
      this._sourceHeight = info.height
      this._sourceType = String(info.type || '').toLowerCase();
      this._sourceBytes = stat.size || file.size || 0
      this.setData({
        hasImage: true,
        sourceSrc: file.path,
        width: info.width,
        height: info.height,
        sourceSizeText: this._sourceBytes ? processing.formatBytes(this._sourceBytes) : '未知大小'
      })
      await this.compressImage()
    } catch (error) {
      if (!this._disposed && token === this._compressToken) {
        this.setData({
          busy: false
        });
        feedback.showError(error, '读取图片失败，请重试')
      }
    }
  },
  getPreset() {
    return this.data.presets.find(item => item.id === this.data.preset) || this.data.presets[1]
  },
  callCompress(options) {
    return new Promise((resolve, reject) => wx.compressImage({
      ...options,
      success: resolve,
      fail: reject
    }))
  },
  async compressImage() {
    if (!this._sourcePath || this._disposed) return
    const token = (this._compressToken || 0) + 1;
    this._compressToken = token
    const current = () => !this._disposed && token === this._compressToken
    const source = this._sourcePath,
      sw = this._sourceWidth,
      sh = this._sourceHeight,
      bytes = this._sourceBytes
    const preset = this.getPreset(),
      format = this.data.format
    const type = format === 'auto' ? (this._sourceType === 'png' ? 'png' : 'jpg') : format
    const size = layout.fitInside(sw, sh, Math.min(preset.maxSide, config.limits.maxImageSide))
    this.setData({
      busy: true,
      resultSrc: '',
      resultSizeText: '—',
      savedPercent: 0,
      resultNotice: ''
    })
    try {
      let path, info
      if (type === 'jpg' && this._sourceType !== 'png') {
        try {
          const result = await this.callCompress({
            src: source,
            quality: preset.quality,
            compressedWidth: size.width,
            compressedHeight: size.height
          })
          if (!current()) return
          info = await media.getImageInfo(result.tempFilePath)
          if (info.width > size.width || info.height > size.height || info.type && !/^(jpg|jpeg)$/i.test(info.type)) throw new Error('需要画布压缩')
          path = result.tempFilePath
        } catch (error) {
          if (!current()) return
        }
      }
      if (!path) {
        const canvas = canvasTools.createCanvas(size.width, size.height)
        try {
          const context = canvas.getContext('2d'),
            image = await canvasTools.loadImage(canvas, source)
          if (!current()) return
          if (type === 'jpg') {
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, size.width, size.height)
          }
          context.drawImage(image, 0, 0, size.width, size.height)
          path = await canvasTools.canvasToTempFile(canvas, type, preset.quality / 100)
          info = size
        } finally {
          canvas.width = 1;
          canvas.height = 1
        }
      }
      if (!current()) return
      const stat = await media.getFileInfo(path)
      if (!current()) return
      let resultBytes = stat.size,
        notice = type === 'png' ? 'PNG 保留透明度，体积取决于原图内容。' : ''
      if (format === 'auto' && bytes > 0 && resultBytes >= bytes && sw <= size.width && sh <= size.height) {
        path = source;
        resultBytes = bytes;
        info = {
          width: sw,
          height: sh
        };
        notice = '原图已经更小，已保留原图，避免重复编码。'
      }
      await contentSecurity.ensureSafe(path)
      if (!current()) return
      this.setData({
        resultSrc: path,
        outputWidth: info.width,
        outputHeight: info.height,
        resultSizeText: resultBytes > 0 ? processing.formatBytes(resultBytes) : '未知大小',
        savedPercent: bytes > 0 && resultBytes > 0 ? Math.max(0, Math.round((1 - resultBytes / bytes) * 100)) : 0,
        resultNotice: notice || (resultBytes > bytes && bytes > 0 ? '转换后的文件更大，可尝试自动格式或轻量档。' : '')
      })
    } catch (error) {
      if (current()) feedback.showError(error, '压缩失败，请重试')
    } finally {
      if (current()) this.setData({
        busy: false
      })
    }
  },
  selectPreset(event) {
    const id = event.currentTarget.dataset.id;
    if (!this.data.presets.some(p => p.id === id) || id === this.data.preset) return;
    this.setData({
      preset: id
    });
    this.compressImage()
  },
  selectFormat(event) {
    const id = event.currentTarget.dataset.id;
    if (!this.data.formats.some(p => p.id === id) || id === this.data.format) return;
    this.setData({
      format: id
    });
    this.compressImage()
  },
  changeImage() {
    this.chooseImage()
  },
  previewResult() {
    if (!this.data.busy && this.data.resultSrc) media.previewImage(this.data.resultSrc)
  },
  async saveResult() {
    if (this.data.busy || !this.data.resultSrc) return;
    try {
      await exportImage.saveWithReward(this.data.resultSrc)
    } catch (error) {
      if (!exportImage.isCancelled(error)) feedback.showError(error, '保存失败，请重试')
    }
  }
})
