Page({
  data: {
    tools: [
      {
        id: 'cutout',
        title: '人像换底色',
        description: '为纯色背景人像更换常用底色',
        glyph: '证',
        badge: '热门',
        tone: 'coral',
        url: '/pages/cutout/index'
      },
      {
        id: 'compress',
        title: '图片压缩',
        description: '画质和大小的平衡，三档快速导出',
        glyph: '缩',
        badge: '常用',
        tone: 'green',
        url: '/pages/compress/index'
      },
      {
        id: 'erase',
        title: '局部擦除',
        description: '抹掉纯色背景上的文字和小水印',
        glyph: '除',
        badge: '新',
        tone: 'yellow',
        url: '/pages/erase/index'
      },
      {
        id: 'collage',
        title: '图片拼接',
        description: '宫格、横版、竖版和海报模板',
        glyph: '拼',
        badge: '',
        tone: 'blue',
        url: '/pages/collage/index'
      },
      {
        id: 'grid',
        title: '九宫格切图',
        description: '一次切成 9 张，保存后按顺序使用',
        glyph: '切',
        badge: '',
        tone: 'purple',
        url: '/pages/grid/index'
      }
    ]
  },

  openTool(event) {
    const url = event.currentTarget.dataset.url
    if (!url) return
    wx.navigateTo({ url: url })
  },

  startCutout() {
    wx.navigateTo({ url: '/pages/cutout/index' })
  }
})

