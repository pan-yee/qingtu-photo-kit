Component({
  data: {
    visible: false,
    contractName: '《拾格图匣隐私保护指引》'
  },

  lifetimes: {
    attached() {
      this.bindPrivacyAuthorization()
    },
    detached() {
      this.resolvePrivacy(false)
    }
  },

  pageLifetimes: {
    show() {
      this.bindPrivacyAuthorization()
    },
    hide() {
      this.resolvePrivacy(false)
      this.setData({ visible: false })
    }
  },

  methods: {
    noop() {},

    bindPrivacyAuthorization() {
      if (!wx.onNeedPrivacyAuthorization) return
      if (!this._privacyResolves) this._privacyResolves = new Set()
      wx.onNeedPrivacyAuthorization((resolve) => {
        this._privacyResolves.add(resolve)
        this.setData({ visible: true })
        this.checkPrivacySetting()
      })
    },

    resolvePrivacy(agreed) {
      const resolves = this._privacyResolves
      if (!resolves) return
      this._privacyResolves = new Set()
      resolves.forEach(function finish(resolve) {
        resolve(agreed
          ? { event: 'agree', buttonId: 'privacy-agree-button' }
          : { event: 'disagree' })
      })
    },

    checkPrivacySetting() {
      if (!wx.getPrivacySetting) return
      wx.getPrivacySetting({
        success: (result) => {
          if (!result.needAuthorization || !this._privacyResolves || !this._privacyResolves.size) return
          this.setData({
            contractName:
              result.privacyContractName || '《拾格图匣隐私保护指引》'
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
      this.resolvePrivacy(true)
      this.setData({ visible: false })
    },

    refusePrivacy() {
      this.resolvePrivacy(false)
      this.setData({ visible: false })
    }
  }
})
