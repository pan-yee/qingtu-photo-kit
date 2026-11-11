const media = require('./media')
const rewarded = require('./rewarded')
const contentSecurity = require('./content-security')

/**
 * 播放激励视频后保存图片，各页面共用同一条保存链路。
 * 返回 true 表示图片已写入相册，false 表示被取消或没有可保存的内容。
 */
let saving = false
async function saveWithReward(path, successTitle) {
  if (!path || saving) return false
  saving = true
  try {
    await contentSecurity.ensureSafe(path)
    const unlocked = await rewarded.unlockHighQuality()
    if (!unlocked) {
      wx.showToast({ title: '完整观看后可保存', icon: 'none' })
      return false
    }
    await media.saveImage(path)
    wx.showToast({ title: successTitle || '已保存到相册', icon: 'success' })
    return true
  } finally { saving = false }
}

/** 用户主动取消的操作不需要弹错误提示。 */
function isCancelled(error) {
  return Boolean(error && error.code === 'CONTENT_SECURITY_CANCELLED') ||
    /cancel/i.test((error && error.errMsg) || '')
}

module.exports = {
  isCancelled,
  saveWithReward
}
