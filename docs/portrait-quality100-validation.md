# 新分支 100 张复杂图验证：阻塞记录

状态：**未完成，实际处理 0/100**。不能引用历史报告作为本分支的新验证结果。

准备使用既有、已冻结的 100 张 COCO 室内杂物照片，来源与原始 SHA256 见 `validation/clutter100-sources.json`。包含沙发织物、床铺衣物、厨房、书桌电脑、餐桌杂物。未按本分支效果替换样本。历史记录仅 9/100 可通过证件照生成门槛，因此本轮属于复杂场景压力回归，不能替代 100 张合适正面半身照的成片验收，也不具备精细发丝 alpha 真值。

## 已准备

- 新增 `scripts/validate-portrait-quality100.py`，固定基线 `336d041`，保存新旧前端模块哈希和 worker 代码哈希。
- 对每张原始图片校验冻结清单中的 SHA256，然后走实际 worker 输入检查和遮罩生成；后端未变，两版复用同一遮罩。前端分别运行各自真实裁切及颜色/alpha 处理。
- 输出蓝底、白底各两版，逐图比较页、汇总 JSON 和 HTML 索引；拒绝与执行错误均计入分母。像素变化只作为差异统计，不冒充质量提升指标。
- 已安装项目固定版本的 Python 推理依赖；脚本帮助与编译检查通过。前端桥支持加载固定基线构图模块。

## 阻塞证据

模型与照片未随 Git 仓库分发，本环境也没有历史本地图片目录。Google Drive 官方模型下载、Hugging Face 数据接口请求均返回 403。后续 HEAD 请求确认 Hugging Face 连接被代理拒绝（`CONNECT tunnel failed, response 403`），GitHub 同期可访问。

用户已在聊天中授权下载，但再查运行环境仍为 restricted、allowed_hosts 为空，重试仍被拒绝；当前工具没有 `cloud_environment.request_changes`，不能把聊天授权直接应用为网络设置。

真实执行命令已运行，预检因缺少固定 SHA256 的 MODNet 权重退出。工作区 `/workspace/scratch/portrait-quality100/report.json` 保留 `processed_count: 0`、`complete: false` 和具体预检错误。没有生成 100 组实图结果，也没有宣称对比通过。

## 恢复运行

在运行环境设置中放行实际使用的来源域名：

- `drive.google.com`、`drive.usercontent.google.com`：官方模型下载与重定向。
- `images.cocodataset.org`：本轮固定 COCO 照片的 HTTPS 图片源。
- 如改用含精细 alpha 标注的 P3M 补充集，另需 `huggingface.co`、`*.huggingface.co`、`*.xethub.hf.co`。

下载 `backend/matting/README.md` 所列模型到忽略目录 `backend/matting/models/modnet.onnx`，原有 worker 在启动时严格验证其 SHA256，然后运行：

```bash
MODNET_MODEL_PATH="$PWD/backend/matting/models/modnet.onnx" \
  /tmp/portrait-quality-venv/bin/python scripts/validate-portrait-quality100.py \
  --output /workspace/scratch/portrait-quality100 --download
```

复核汇总 JSON 的实际错误和拒绝数，并逐张查看 `review.html`。完成后再记录改善、退化和无变化案例；真实图片本身不提交 Git 或部署到生产。
