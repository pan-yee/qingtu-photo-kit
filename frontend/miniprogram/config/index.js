module.exports = {
  appName: '拾格图匣',
  portraitBackend: 'ecs', // 'local' 可显式选择设备端轻量分割；服务失败不自动降级。

  // backend: 'cloud' 使用微信云开发；'http' 使用自有部署。修改后重新编译。
  // 两套参数同时保留，只启用选中的后端；服务异常时不会自动切换或跳过审核。
  contentSecurity: {
    backend: 'cloud',
    envId: 'photo-d0gn3yvetb21c4a41',
    functionName: 'contentSecurity',
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

