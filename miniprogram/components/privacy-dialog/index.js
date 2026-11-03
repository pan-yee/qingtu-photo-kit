Component({
  data: {
    visible: false,
    contractName: '《轻图盒隐私保护指引》'
  },

  lifetimes: {
    attached() {
      this.checkPrivacySetting()
    }
  },

  methods: {
    noop() {},

    checkPrivacySetting() {
      if (!wx.getPrivacySetting) return
      wx.getPrivacySetting({
        success: (result) => {
          if (!result.needAuthorization) return
          this.setData({
            visible: true,
            contractName:
              result.privacyContractName || '《轻图盒隐私保护指引》'
          })
        }
      })
    },

    openPrivacyContract() {
      if (!wx.openPrivacyContract) {
        wx.showToast({
          title: '请在小程序后台查看隐私保护指引',
          icon: 'none'
        })
        return
      }
      wx.openPrivacyContract({
        fail: () => {
          wx.showModal({
            title: '隐私保护指引未配置',
            content:
              '请先在小程序管理后台完成用户隐私保护指引，再提交审核。',
            showCancel: false
          })
        }
      })
    },

    agreePrivacy() {
      this.setData({ visible: false })
    },

    refusePrivacy() {
      if (wx.exitMiniProgram) {
        wx.exitMiniProgram()
        return
      }
      this.setData({ visible: false })
      wx.showToast({
        title: '你可以随时关闭小程序',
        icon: 'none'
      })
    }
  }
})

