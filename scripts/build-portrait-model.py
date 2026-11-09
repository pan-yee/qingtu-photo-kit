"""将固定版本 MediaPipe TFLite 转成小程序用的标准 ONNX 算子。改动说明见 docs/人像分割.md。"""
import argparse
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile

import numpy as np
import onnx
from onnx import helper as h, numpy_helper as nh

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path, help='selfie_segmentation.tflite from the pinned npm package')
parser.add_argument('output', type=Path, help='Write rebuilt model here; review and validate before replacing the shipped model')
args = parser.parse_args()
expected = '8d13b7fae74af625c641226813616a2117bd6bca19eb3b75574621fc08557f27'
if hashlib.sha256(args.source.read_bytes()).hexdigest() != expected:
    raise SystemExit('Source model checksum mismatch')
with tempfile.TemporaryDirectory() as directory:
    converted = Path(directory) / 'converted.onnx'
    subprocess.run([sys.executable, '-m', 'tf2onnx.convert', '--tflite', str(args.source),
                    '--inputs-as-nchw', 'input_1', '--outputs-as-nchw', 'activation_10',
                    '--opset', '11', '--output', str(converted)], check=True)
    model = onnx.load(converted)

for name, value in [('portrait_three', 3.), ('portrait_zero', 0.),
                    ('portrait_six', 6.), ('portrait_sixth', 1/6)]:
    model.graph.initializer.append(nh.from_array(np.array(value, dtype=np.float32), name))
weights = {value.name: nh.to_array(value) for value in model.graph.initializer}
nodes = []
counts = {'HardSwish': 0, 'TFL_Convolution2DTransposeBias': 0}
for node in model.graph.node:
    if node.op_type == 'HardSwish':
        counts[node.op_type] += 1
        base = node.name
        nodes.extend([
            h.make_node('Add', [node.input[0], 'portrait_three'], [base + '_add']),
            h.make_node('Clip', [base + '_add', 'portrait_zero', 'portrait_six'], [base + '_clip']),
            h.make_node('Mul', [node.input[0], base + '_clip'], [base + '_mul']),
            h.make_node('Mul', [base + '_mul', 'portrait_sixth'], list(node.output))
        ])
    elif node.op_type == 'TFL_Convolution2DTransposeBias':
        counts[node.op_type] += 1
        # 这个固定模型的最后一层：NHWC、2×2 内核、stride=2、无 padding。
        kernel = weights[node.input[1]]
        assert kernel.shape == (1, 2, 2, 16)
        model.graph.initializer.append(nh.from_array(
            kernel.transpose(3, 0, 1, 2).copy(), 'portrait_transpose_weights'))
        nodes.extend([
            h.make_node('Transpose', [node.input[0]], ['portrait_nchw'], perm=[0, 3, 1, 2]),
            h.make_node('ConvTranspose', ['portrait_nchw', 'portrait_transpose_weights', node.input[2]],
                        ['portrait_segment_nchw'], kernel_shape=[2, 2], strides=[2, 2]),
            h.make_node('Transpose', ['portrait_segment_nchw'], list(node.output), perm=[0, 2, 3, 1])
        ])
    else:
        nodes.append(node)
assert counts == {'HardSwish': 11, 'TFL_Convolution2DTransposeBias': 1}, counts
model.graph.ClearField('node')
model.graph.node.extend(nodes)
onnx.checker.check_model(model, full_check=True)
args.output.parent.mkdir(parents=True, exist_ok=True)
onnx.save(model, args.output)
print('Rebuilt model SHA-256:', hashlib.sha256(args.output.read_bytes()).hexdigest())
print('Graph names may vary between conversions. Validate numeric outputs before replacing the shipped model.')
