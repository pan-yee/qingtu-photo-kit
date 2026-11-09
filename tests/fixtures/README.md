`astronaut.png` 来自 scikit-image v0.19.3，NASA 宇航员 Eileen Collins 的公开照片。

- 原图：https://github.com/scikit-image/scikit-image/blob/v0.19.3/skimage/data/astronaut.png
- 来源与权利说明：https://github.com/scikit-image/scikit-image/blob/v0.19.3/skimage/data/_fetchers.py （`astronaut()`：public domain / no known copyright restrictions）
- SHA-256：`88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`

该照片仅用于回归验证，不代表证件照标准样本；不能将单张样本的结果外推为整体准确率。

`mediapipe-astronaut-alpha.png` 是官方 `@mediapipe/selfie_segmentation@0.1.1675465747` 在 Chromium WebGL 中对 `astronaut.png` 缩放到 256×256 后得到的 alpha 通道。输入缩放采用 Pillow 默认的 bicubic；浏览器读取该无损 PNG，不做额外缩放。`modelSelection: 0, selfieMode: false`。PNG 保存 8-bit alpha，允许少量 GPU 浮点和量化误差。

它只用于验证 ONNX 转换与官方实现一致，**不是人工标注的正确人像遮罩**。官方模型的 Apache-2.0 许可见 `miniprogram/models/LICENSE.txt`。
