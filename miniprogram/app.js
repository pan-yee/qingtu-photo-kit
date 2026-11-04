App({
  globalData: {
    appName: '轻图盒图片处理工具',
    version: '1.0.0'
  },

  onLaunch() {
    try {
      const accountInfo = wx.getAccountInfoSync()
      this.globalData.envVersion =
        accountInfo && accountInfo.miniProgram
          ? accountInfo.miniProgram.envVersion
          : 'develop'
    } catch (error) {
      this.globalData.envVersion = 'develop'
    }
  },

  onPageNotFound(result) {
    console.warn('Page not found, redirecting to home:', result)
    wx.reLaunch({
      url: '/pages/home/index',
      fail: function fallback(error) {
        console.error('Unable to open the home page:', error)
      }
    })
  }
})

