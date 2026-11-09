module.exports = {
  appName: '拾格图匣',

  // 部署内容安全云函数后填入环境 ID；未配置时图片处理与导出保持拦截。
  contentSecurity: {
    envId: '',
    functionName: 'contentSecurity'
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

