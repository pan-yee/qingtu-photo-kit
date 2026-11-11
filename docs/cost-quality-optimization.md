# 成本与证件照质量优化

本轮继续使用已有 ECS 的 CPU 和经过 SHA256 校验的 MODNet，不增加 GPU 或按张收费的抠图服务。没有真实月账单、使用量和不同用户的质量评分，不能宣称是绝对最低成本或最高质量方案。

## 已实现

1. 原图先通过微信内容审核。为抠图生成的内部 JPEG 等比限制最长边 1600，复用原图的摘要审核缓存，不再把这个内部副本单独上传审核。最终展示、预览和保存仍使用原有安全校验链路；审核异常仍阻断输出。首次结果通常从原图、内部副本、最终图三份不同内容的审核减少为原图和最终图两份，实际账单节省取决于缓存、云额度和操作次数。
2. 在完整照片上进行轻量正面人脸检测，单人时对保留头发、肩部余量的区域只推理一次。返回区域在原图中的坐标，前端统一映射透明度、原图和涂抹坐标，再按人脸及发顶辅助构图。换背景、尺寸与手动修正继续复用遮罩。
3. MODNet 默认参数保留原始连续透明度，取消默认的非线性透明度增强。额外柔化使用空间插值。增加可关闭的边缘去残色，只根据邻近可靠背景保守修正半透明像素，不修改不透明人脸、衣服或原始图片。
4. 检测到多个主要人脸时提示换单人照片。无正面人脸或旧服务未提供人脸元数据时提示检查居中构图，不伪造人脸位置。
5. 抠图进程最多一张处理、两张等待，最长等待 12 秒；队列已满时返回 429，并显示明确的繁忙提示。队列是有界等待，不保证严格先进先出，也不能解决持续超负载。

人脸检测采用 OpenCV 包内的 Haar 正面检测器，没有新增模型下载或按次费用。它是低成本构图提示，对侧脸、倾斜和遮挡存在局限；没有做人脸身份识别、眼线对齐、姿态或机构受理标准认证。头发在输入中已经缺失时，也不会生成补全。

## 复现本地验证

在仓库根目录执行，模型路径按实际文件位置填写。模型无需提交 Git：

```sh
python -m venv /workspace/.qingtu-matting-validation
/workspace/.qingtu-matting-validation/bin/pip install -r backend/matting/requirements.txt
npm run check
MODNET_MODEL_PATH=/path/to/modnet.onnx /workspace/.qingtu-matting-validation/bin/python backend/matting/test_worker.py
/workspace/.qingtu-matting-validation/bin/python scripts/compare-matting.py \
  --image frontend/tests/fixtures/astronaut.png --stress \
  --model MODNet=/path/to/modnet.onnx \
  --model Hivision-MODNet=/path/to/hivision_modnet.onnx \
  --output /workspace/qingtu-validation/matting-review
```

对比工具在本地复用小程序实际的构图、遮罩与边缘处理代码，没有调用云端审核，也不用于向用户发布图片。输入为本地图片，未模拟手机 canvas 的全部实现差异、JPEG 压缩、微信登录或网络上传耗时。记录的是 CPU 预热后推理耗时，不是完整生成时间；不同模型的输入形状可能不同，不应仅按耗时推断质量。

基准使用仓库已有的 NASA 公共照片及六种变换：宽幅偏左、宽幅偏右、低亮度、低对比度、轻微倾斜、低分辨率。它们只有一个独立人物，没有真值遮罩或人工评分。真实模型输出会影响辅助构图，因此图中“前后”同时体现构图和边缘处理变化，不能单凭该图隔离判断去残色是否改善。

结果、两个模型的 SHA256 与对比图见 [验证报告](validation/cost-quality-report.json)。保留原版 MODNet 为默认；Hivision 适配模型作为离线候选，没有接入生产配置。BiRefNet 尚未进行本项目实测，较高的资源需求需要另行验证，不能直接放入现有 700 MiB 限额容器。

另已构建实际 worker 镜像，并在 UID 65534、只读根文件系统、移除 capabilities 的容器中完成真实 HTTP 抠图请求；修复了源文件权限较严时非 root 无法读取 Python 代码的问题。容器内 worker 的峰值 RSS 约 342 MiB。构建使用 `PYTHON_BASE_IMAGE=python:3.12-slim` 和仅在构建步骤挂载的 CA，默认生产镜像来源保持原配置，未关闭 TLS 校验。当前嵌套 Docker 虽收到 700 MiB / 2 CPU 配置，但实际暴露的是外层共享 cgroup，不能用本次测试证明资源硬限额生效，仍须在 ECS 复核。

## 上线与后续验收

- 本轮为本地代码和验证结果，未重新部署 ECS、上传微信开发版或触发平台审核。前后端需配套更新，旧后端可继续处理但不会启用人脸辅助构图。
- 仓库此前的外网验收记录存在域名备案阻断，不能用同机请求成功代替真机测试。本轮没有复测或解决备案问题。
- 使用获得授权的 30–50 位不同人物照片，覆盖卷发、细发丝、眼镜、白衣、相近背景、暗光和偏位；逐张比较发丝、光晕、衣服完整度与构图，记录失败率及人工评分。工具可重复传入 `--image`，不要把扩增图计作独立人物。
- 在实际 ECS 上复核 700 MiB 限额、排队、持续峰值和端到端延迟；内容审核需另外通过真实微信接口和真机验证。账单比较需要 ECS 固定费、带宽、云开发额度与调用量，当前没有计算实际月费。
- 再决定是否替换人脸检测器、采用 Hivision 权重或测试 BiRefNet。依赖代码和权重的许可均须按实际分发版本核对，随镜像保留包内许可。

参考开源项目：[MODNet](https://github.com/ZHKKKe/MODNet)、[HivisionIDPhotos](https://github.com/Zeyi-Lin/HivisionIDPhotos)、[OpenCV](https://github.com/opencv/opencv)。
