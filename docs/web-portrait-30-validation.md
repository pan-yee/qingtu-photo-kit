# 30 张网络公开人像验证（2026-11-11）

本次下载 P3M-500-NP 测试集的 30 张不同照片及人工 alpha 标注，在模型推理前固定选择 500 行中的 30 个等距行号。不替换失败样本、不使用同一照片的增强图凑数，但没有核实这些照片是否来自 30 位不同人物。样本包含非正面、遮挡、背影及源图截头等素材，不等同于 30 张合格证件照素材。

来源为 [P3M 原始项目](https://github.com/JizhiziLi/P3M) 和 [Hugging Face 下载镜像](https://huggingface.co/datasets/nobg/P3M-10K)。已阅读[数据集发布协议](https://jizhizili.github.io/files/p3m_dataset_agreement/P3M-10k_Dataset_Release_Agreement.pdf)：数据集按 MIT 发布，照片版权属于原权利人。引用：Li, Jizhizi, Sihan Ma, Jing Zhang, and Dacheng Tao. “Privacy-Preserving Portrait Matting.” ACM Multimedia, 2021。

## 结果

- 下载并评估全部 30 张，使用项目锁定依赖：ONNX Runtime 1.23.2、NumPy 2.2.6、Pillow 11.3.0、OpenCV 4.12.0.88，MODNet 模型 SHA256 与生产配置一致。
- 3 张出现严重自动构图错误：`p3m-np-310` 裁成下半身；`p3m-np-344` 裁成衣服；`p3m-np-396` 裁成头发局部。检测框落在了非人脸部位。
- 1 张遮挡样本 `p3m-np-293` 的书本和头部被大块抠除。
- 1 张单人照片 `p3m-np-103` 的衣摆被误检为第二个人脸，产品会错误拒绝生成。已查看两个检测框确认。
- 单脸检测 15 张、未检出人脸 14 张、多脸判定 1 张。由于大量样本为背影、侧脸或遮挡，不能把 14/30 当作正面人脸漏检率。
- 最终裁切区域平均 alpha MAE 0.015803；此项不评价构图是否包含人脸，也不评价 RGB 边缘残色，不能换算成 98.4% 准确率。
- 本机 Windows CPU、2 个 ONNX 推理线程：每图预热一次后计时三次，共 90 个记录，中位数约 614 ms，P95 约 1141 ms。未计入网络、手机 canvas、安全审核和排队，不代表 ECS 端到端耗时。

已逐张目视查看原图、蓝底、白底与同一裁切区域的人工标注对比。这是助手的视觉复查，不是独立盲评或证件照受理标准认证。部分普通人像的头发、脸和衣服保留良好，但目前不能认定为高质量全自动证件照方案。应优先修复人脸误检、素材筛选和构图完整性，再比较更大的抠图模型。

完整数值与逐张备注见 [JSON 报告](validation/web-portrait-30-report.json)。交互报告、30 张原图与标注保存在本次本地验证输出目录，没有上传到 ECS、微信或其他检测 API。本次没有改动生产模型、产品算法或重新部署。

## 复现

在独立 Python 环境安装 `backend/matting/requirements.txt`，确保 Node.js 可用。将已校验的模型路径和本地输出目录传给以下命令：

```sh
python scripts/validate-portrait-web30.py --model /path/to/modnet.onnx --output /path/to/review --run-name run-pinned
python scripts/build-portrait-web30-review.py --output /path/to/review
```

下载清单 `sources.json` 记录行号、来源页面、原始图片与标注文件哈希；`evaluation.json` 记录指标与版本；`review.html` 可离线浏览并逐张切换，另生成一份 `.canvas.tsx` 画布。评估在内部复用了小程序的真实构图、alpha 和边缘处理代码，没有经过微信审核，仅用于本地质量检查。
