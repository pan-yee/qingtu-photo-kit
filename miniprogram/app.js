App({
  globalData: {
    appName: '轻图盒',
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
  }
})

