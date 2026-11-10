module.exports = {
  appName: '拾格图匣',

  // 独立自有服务器；完成部署、微信合法域名与可信回调配置后才可处理图片。
  contentSecurity: {
    backend: 'http',
    apiBaseUrl: 'https://www.ai-dreams.xyz/qingtu-api'
  },

  // 配置正式广告位 ID 后，保存高清图片前展示激励视频。
  enableRewardedAds: false,
  rewardedVideoAdUnitId: '',

  limits: {
    maxImageSide: 1600,
    eraseCanvasSide: 900,
    photoWidth: 900,
    photoHeight: 1200,
    gridSide: 1200
  }
}

