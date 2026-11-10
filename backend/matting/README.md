# MODNet 人像抠图

安全检测保持微信云函数默认同步模式；抠图独立使用 ECS CPU 服务，通过现有 HTTPS API 的 `/jobs/matte` 接入，使用微信登录 JWT，单用户每分钟最多 6 次。抠图 worker 没有公网端口，单任务推理，700 MB 内存限制。输入限 JPEG/PNG、10 MiB、2400 万像素，图片与遮罩仅在内存处理，不写磁盘、不记录正文。

模型来自 MODNet 官方仓库 `https://github.com/ZHKKKe/MODNet/tree/master/onnx` 所链接的 ONNX 下载：
`https://drive.google.com/uc?export=download&id=1cgycTQlYXpTh26gB9FTnthE7AvruV8hd`。
将文件保存为 `matting/models/modnet.onnx`，SHA-256 必须为 `07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9`，服务启动时校验。模型和文件许可见 `LICENSE.MODNet`，模型不提交 Git。

在 backend 目录运行：

```sh
docker compose --env-file .env -f docker-compose.host-db.yml -f docker-compose.matting.yml up -d --build
```

若 ECS 下载 Python 依赖较慢，可以在构建命令前设置 `PYTHON_PACKAGE_INDEX=https://mirrors.aliyun.com/pypi/simple`，不关闭 TLS 校验。使用非个人的公共测试照片，可在 app 容器运行 `node scripts/smoke-matting.js /tmp/test-portrait.png` 验证 HTTPS 路由、鉴权和真实推理；脚本不输出登录凭据或图片数据，不替代手机微信登录测试。

前端 `portraitBackend: 'ecs'` 启用高清抠图，`'local'` 显式选择原设备端模型。ECS 不可用时显示错误，不自动降级为颜色删除算法。首次处理单独征求上传授权；小程序后台隐私指引需补充运营者服务器处理证件照图片，并将 `https://www.ai-dreams.xyz` 加入 request 合法域名。前端使用 wx.request 二进制请求，不需要 uploadFile 域名。

域名外部访问必须单独验证，不能仅从 ECS 自身发起请求代替手机验收。当前外部 HTTP 探测返回 `403 Non-compliance ICP Filing`，HTTPS 域名握手中断；需先解决网站备案或阿里云接入备案阻断。微信小程序备案、request 合法域名设置与网站备案是不同配置。

模型返回连续 alpha，前端保留原图 RGB，按 alpha 合成背景，不使用生成模型重绘人脸。复杂背景、相近衣服颜色等仍须真实样本验证；单张公共测试图片不能证明整体效果。

回滚时将前端 portraitBackend 改为 local 并重新编译；原后端 compose 文件未修改，可恢复 app.js 备份并使用原 compose 重建 app。停止 matting 服务即可释放模型内存，数据库和云安全检测不受影响。
