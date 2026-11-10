/**
 * 统一的失败提示，避免每个页面各写一份 showError。
 */
function showError(error, fallbackTitle) {
  console.error(error)
  wx.showToast({
    title: (error && error.message) || fallbackTitle || '处理失败，请重试',
    icon: 'none'
  })
}

module.exports = {
  showError
}
