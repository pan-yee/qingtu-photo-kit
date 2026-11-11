"""Offline MODNet-family comparison. Timings and previews do not establish quality rankings.

Run with backend/matting/requirements.txt installed, Node.js and explicit model files.
Use --image repeatedly for an authorized representative set (suggested: 30-50 images).
No network or cloud audit API calls; never use this tool to publish unchecked user images.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw, ImageOps, ImageEnhance

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend/matting'))
from framing import detect_faces, portrait_region


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', type=Path, action='append', required=True)
    parser.add_argument('--model', action='append', required=True, help='label=/path/to/model.onnx; MODNet-compatible RGB [-1,1] only')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--stress', action='store_true', help='Add six controlled variants of the first image, not six independent subjects')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    source_images = len(args.image)
    if args.stress:
        fixtures = args.output / 'fixtures'
        fixtures.mkdir(exist_ok=True)
        fixture = ImageOps.exif_transpose(Image.open(args.image[0])).convert('RGB').resize((512, 512))
        variants = {}
        for name, x in [('wide-left', 0), ('wide-right', 512)]:
            canvas = Image.new('RGB', (1024, 512), (210, 215, 220))
            canvas.paste(fixture, (x, 0))
            variants[name] = canvas
        variants.update({'low-light': ImageEnhance.Brightness(fixture).enhance(.65),
                         'low-contrast': ImageEnhance.Contrast(fixture).enhance(.65),
                         'tilted': fixture.rotate(8, resample=Image.Resampling.BICUBIC, fillcolor=(210, 215, 220)),
                         'low-resolution': fixture.resize((256, 256))})
        for name, fixture in variants.items():
            path = fixtures / (name + '.png')
            fixture.save(path)
            args.image.append(path)
    report = {'scope': 'Offline CPU test. No ground-truth masks, human quality scores, real-device or production concurrency verification.',
              'onnxruntime': ort.__version__, 'source_images': source_images,
              'derived_stress_cases': len(args.image) - source_images, 'images': len(args.image), 'models': []}
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    bridge = ROOT / 'frontend/scripts/matting-pixels.js'

    def infer(session, image):
        width, height = image.size
        scale = min(512 / min(width, height), 1024 / max(width, height))
        size = (max(32, int(width * scale) // 32 * 32), max(32, int(height * scale) // 32 * 32))
        shape = session.get_inputs()[0].shape
        if isinstance(shape[2], int) and isinstance(shape[3], int):
            size = (shape[3], shape[2])
        values = (np.asarray(image.resize(size, Image.Resampling.BOX), dtype=np.float32) - 127.5) / 127.5
        tensor = values.transpose(2, 0, 1)[None]
        start = time.perf_counter()
        result = session.run(None, {session.get_inputs()[0].name: tensor})[0].squeeze()
        elapsed = (time.perf_counter() - start) * 1000
        if result.shape != (size[1], size[0]) or not np.isfinite(result).all():
            raise ValueError('Not a compatible MODNet matte')
        # Mirror actual worker's 8-bit PNG transport, rather than testing pristine float alpha.
        return np.rint(np.clip(result, 0, 1) * 255).astype(np.float32) / 255, elapsed

    for number, spec in enumerate(args.model):
        label, model_path = spec.split('=', 1)
        model = Path(model_path)
        entry = {'name': label, 'sha256': hashlib.sha256(model.read_bytes()).hexdigest(), 'samples': []}
        session = ort.InferenceSession(str(model), sess_options=options, providers=['CPUExecutionProvider'])
        entry['input_shape'] = session.get_inputs()[0].shape
        for index, image_path in enumerate(args.image):
            folder = args.output / f'model-{number}-image-{index}'
            folder.mkdir(exist_ok=True)
            original = ImageOps.exif_transpose(Image.open(image_path)).convert('RGB')
            original.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
            faces = detect_faces(original)
            inference_image, region = portrait_region(original, faces)
            infer(session, inference_image)  # Warm up, excluded from timing.
            times = []
            for _ in range(3):
                mask, elapsed = infer(session, inference_image)
                times.append(round(elapsed, 2))
            mask.tofile(folder / 'full.f32')
            metadata = {'width': original.width, 'height': original.height, 'face': faces[0] if len(faces) == 1 else None,
                        'region': region,
                        'maskPath': str(folder / 'full.f32'), 'maskWidth': mask.shape[1], 'maskHeight': mask.shape[0],
                        'output': str(folder / 'framed')}
            (folder / 'frame-request.json').write_text(json.dumps(metadata))
            subprocess.run(['node', str(bridge), 'frame', str(folder / 'frame-request.json')], check=True)
            framed = json.loads((folder / 'framed.json').read_text())
            crop = framed['crop']
            # Affine sampling permits transparent padding, like the app's source canvas.
            source = original.convert('RGBA').transform((900, 1200), Image.Transform.AFFINE,
                (crop['sw']/900, 0, crop['sx'], 0, crop['sh']/1200, crop['sy']), Image.Resampling.BILINEAR)
            (folder / 'source.rgba').write_bytes(source.tobytes())
            render = {'maskPath': str(folder / 'framed.f32'), 'maskWidth': framed['width'], 'maskHeight': framed['height'],
                      'imagePath': str(folder / 'source.rgba'), 'output': str(folder / 'result.rgba')}
            (folder / 'render-request.json').write_text(json.dumps(render))
            subprocess.run(['node', str(bridge), 'render', str(folder / 'render-request.json')], check=True)
            result = Image.frombytes('RGBA', (900, 1200), (folder / 'result.rgba').read_bytes())
            # Baseline: previous center-crop-before-inference and default alpha remapping.
            old = ImageOps.fit(original, (900, 1200), method=Image.Resampling.BILINEAR)
            old_mask, _ = infer(session, old)
            alpha = np.asarray(Image.fromarray(old_mask).resize((900, 1200), Image.Resampling.BILINEAR))
            alpha = alpha + (alpha * alpha * (3 - 2 * alpha) - alpha) * (3 / 8)
            baseline = old.convert('RGBA')
            baseline.putalpha(Image.fromarray(np.rint(alpha * 255).astype(np.uint8)))
            sheet = Image.new('RGB', (960, 680), 'white')
            draw = ImageDraw.Draw(sheet)
            for column, (title, photo, color) in enumerate([
                ('BEFORE / blue', baseline, '#438edb'), ('AFTER / blue', result, '#438edb'), ('AFTER / white', result, 'white')]):
                composite = Image.new('RGBA', photo.size, color)
                composite.alpha_composite(photo)
                sheet.paste(composite.convert('RGB').resize((300, 400)), (column * 320 + 10, 30))
                draw.text((column * 320 + 10, 10), title, fill='black')
                # Edge inspection, identical normalized upper-head region per output.
                detail = composite.crop((200, 40, 700, 360)).convert('RGB').resize((300, 192))
                sheet.paste(detail, (column * 320 + 10, 450))
            sheet.save(folder / 'comparison.png')
            entry['samples'].append({'image': image_path.name, 'faces': len(faces), 'crop': crop,
                                     'inference_ms': times, 'preview': str((folder / 'comparison.png').relative_to(args.output))})
        report['models'].append(entry)
    (args.output / 'report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
