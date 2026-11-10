"""校验转换模型与官方 MediaPipe WASM 在同一输入上的数值一致性。"""
import argparse
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--model', type=Path, default=root / 'miniprogram/models/selfie-segmentation.onnx')
args = parser.parse_args()
image = Image.open(root / 'tests/fixtures/astronaut.png').convert('RGB').resize((256, 256))
inputs = np.asarray(image, dtype=np.float32)[None].transpose(0, 3, 1, 2) / 255
options = ort.SessionOptions()
options.intra_op_num_threads = 2
session = ort.InferenceSession(str(args.model), sess_options=options, providers=['CPUExecutionProvider'])
output = session.run(None, {'input_1': inputs})[0][0, 0]
reference = np.asarray(Image.open(root / 'tests/fixtures/mediapipe-astronaut-alpha.png'), dtype=np.float32) / 255
delta = np.abs(output-reference)
a, b = output > .5, reference > .5
iou = float(np.sum(a & b) / np.sum(a | b))
assert float(delta.mean()) < .001, 'Average conversion error too large'
assert float(delta.max()) < .04, 'Maximum conversion error too large'
assert iou > .999, 'Converted mask differs from official runtime'
print(json.dumps({'mean_absolute_error': float(delta.mean()), 'max_absolute_error': float(delta.max()),
                  'binary_mask_iou_vs_official_runtime': iou,
                  'scope': 'Single-input conversion regression vs official WASM, not ground-truth segmentation accuracy.'}, indent=2))
