"""真实图片回归；依赖 numpy、Pillow、onnxruntime，Node.js；无网络调用。"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', type=Path, default=ROOT / 'tests/fixtures/astronaut.png')
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
manifest = json.loads((ROOT / 'miniprogram/models/manifest.json').read_text())
model = ROOT / 'miniprogram/models/selfie-segmentation.onnx'
assert hashlib.sha256(model.read_bytes()).hexdigest() == manifest['sha256'], 'Model checksum mismatch'
source = Image.open(args.image).convert('RGBA')
# 与小程序一致：居中裁剪到 3:4，再缩放到处理画布。
w, h = source.size
sw, sh = min(w, h * 3 / 4), min(h, w * 4 / 3)
source = source.resize((900, 1200), Image.Resampling.BILINEAR,
                       box=((w-sw)/2, (h-sh)/2, (w+sw)/2, (h+sh)/2))
image_path = args.output / 'source.rgba'
image_path.write_bytes(source.tobytes())
input_path = args.output / 'input.f32'
bridge = ROOT / 'scripts/portrait-pixels.js'
subprocess.run(['node', str(bridge), 'input', str(image_path), '900', '1200', str(input_path)], check=True)
inputs = np.fromfile(input_path, dtype=np.float32).reshape(1, 3, 256, 256)
options = ort.SessionOptions()
options.intra_op_num_threads = 2
session = ort.InferenceSession(str(model), sess_options=options, providers=['CPUExecutionProvider'])
assert session.get_inputs()[0].name == manifest['input']['name']
assert session.get_inputs()[0].shape == manifest['input']['shape']
assert session.get_outputs()[0].shape == manifest['output']['shape']
# 预热后记录 5 次原生 CPU 推理；不把这个数当作手机耗时或完整生成耗时。
session.run(None, {'input_1': inputs})
times = []
for _ in range(5):
    start = time.perf_counter()
    mask = session.run(None, {'input_1': inputs})[0]
    times.append((time.perf_counter() - start) * 1000)
assert np.isfinite(mask).all() and mask.min() >= 0 and mask.max() <= 1
mask_path = args.output / 'mask.f32'
mask.tofile(mask_path)
prefix = args.output / 'portrait'
subprocess.run(['node', str(bridge), 'render', str(image_path), '900', '1200', str(prefix), str(mask_path)], check=True)
results = {}
for name in ['legacy', 'model']:
    rgba = Image.frombytes('RGBA', source.size, Path(str(prefix) + '.' + name + '.rgba').read_bytes())
    alpha = np.asarray(rgba)[:, :, 3] / 255
    assert alpha.max() > 0.9 and alpha.min() < 0.1, 'Degenerate cutout'
    bg = Image.new('RGBA', source.size, '#438edb')
    bg.alpha_composite(rgba)
    bg.convert('RGB').save(args.output / (name + '.png'))
    # 人工选定的实心区域抽查，不是完整标注的 IoU 或总体准确率。
    if args.image.resolve() == (ROOT / 'tests/fixtures/astronaut.png').resolve():
        def mean_rect(rect):
            x0, y0, x1, y1 = rect
            return float(alpha[round(y0*1200/512):round(y1*1200/512),
                               round(x0*900/384):round(x1*900/384)].mean())
        results[name] = {
            'face_alpha_mean': mean_rect((120, 90, 190, 160)),
            'suit_alpha_mean': mean_rect((50, 280, 150, 390)),
            'background_alpha_mean': mean_rect((280, 30, 350, 180))
        }
if results:
    assert results['model']['face_alpha_mean'] > .95, 'Face removed'
    assert results['model']['suit_alpha_mean'] > .95, 'Suit removed'
    assert results['model']['background_alpha_mean'] < .05, 'Background retained'
comparison = Image.new('RGB', (384 * 3, 512 + 32), 'white')
draw = ImageDraw.Draw(comparison)
for column, (label, image) in enumerate([
    ('Input (NASA / public domain)', source.convert('RGB')),
    ('Previous color-based cutout', Image.open(args.output / 'legacy.png')),
    ('MediaPipe local portrait mask', Image.open(args.output / 'model.png'))
]):
    draw.text((column * 384 + 8, 10), label, fill='black')
    comparison.paste(image.resize((384, 512)), (column * 384, 32))
comparison.save(args.output / 'comparison.png')
report = {
    'model_sha256': manifest['sha256'],
    'image_sha256': hashlib.sha256(args.image.read_bytes()).hexdigest(),
    'image_count': 1,
    'onnxruntime_version': ort.__version__,
    'cpu_inference_mean_ms': float(np.mean(times)),
    'region_probes': results,
    'scope': 'One real-image regression and selected opaque-region probes; no full ground truth. Not a WeChat runtime or platform safety audit.'
}
(args.output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
