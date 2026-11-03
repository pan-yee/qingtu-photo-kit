const config = require('../config/index')

let rewardedAd = null
let pendingResolve = null

function getAd() {
  if (!config.rewardedVideoAdUnitId || !wx.createRewardedVideoAd) {
    return null
  }
  if (!rewardedAd) {
    rewardedAd = wx.createRewardedVideoAd({
      adUnitId: config.rewardedVideoAdUnitId
    })
    rewardedAd.onClose(function onClose(result) {
      const completed = !result || result.isEnded
      if (pendingResolve) {
        pendingResolve(completed)
        pendingResolve = null
      }
    })
    rewardedAd.onError(function onError() {
      if (pendingResolve) {
        pendingResolve(true)
        pendingResolve = null
      }
    })
  }
  return rewardedAd
}

function unlockHighQuality() {
  if (!config.enableRewardedAds) {
    return Promise.resolve(true)
  }
  const ad = getAd()
  if (!ad) {
    return Promise.resolve(true)
  }
  return new Promise(function show(resolve) {
    pendingResolve = resolve
    ad.show().catch(function retry() {
      return ad.load().then(function loaded() {
        return ad.show()
      })
    }).catch(function failed() {
      pendingResolve = null
      resolve(true)
    })
  })
}

module.exports = {
  unlockHighQuality
}

