"""Reproducible 30-photo offline evaluation. Downloads public P3M test images.

No cloud API calls, uploads, product configuration changes or model training.
Run with backend/matting/requirements.txt and Node.js available.
"""
import argparse
import concurrent.futures
import hashlib
import io
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import time
import urllib.parse
import urllib.request

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1]
DATASET = 'nobg/P3M-10K'
SPLIT = 'P3M_500_NP'
EXPECTED_MODEL = '07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9'


def download(url):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                return response.read()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1 + attempt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--run-name', default='run')
    args = parser.parse_args()
    if hashlib.sha256(args.model.read_bytes()).hexdigest() != EXPECTED_MODEL:
        raise ValueError('Production model checksum mismatch')
    out = args.output.resolve()
    raw = out / 'dataset'
    raw.mkdir(parents=True, exist_ok=True)
    # Fixed BEFORE inference: 30 uniformly spaced rows, inclusive of both ends.
    indices = [round(i * 499 / 29) for i in range(30)]
    manifest_file = out / 'sources.json'
    if manifest_file.exists():
        manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
        assert [row['row_index'] for row in manifest['samples']] == indices
    else:
        selected = {}
        for offset in range(0, 500, 100):
            query = urllib.parse.urlencode(dict(dataset=DATASET, config='default', split=SPLIT, offset=offset, length=100))
            page = json.loads(download('https://datasets-server.huggingface.co/rows?' + query))
            for record in page['rows']:
                if record['row_idx'] in indices:
                    selected[record['row_idx']] = record['row']
        assert len(selected) == 30

        def fetch(index):
            record = selected[index]
            identifier = 'p3m-np-' + str(index).zfill(3)
            result = {'id': identifier, 'row_index': index,
                      'source': 'https://huggingface.co/datasets/nobg/P3M-10K/viewer/default/P3M_500_NP?row=' + str(index)}
            for field in ['image', 'mask']:
                content = download(record[field]['src'])
                image = Image.open(io.BytesIO(content))
                image.load()
                image.convert('RGB' if field == 'image' else 'L').save(raw / (identifier + '-' + field + '.png'))
                result[field + '_sha256'] = hashlib.sha256(content).hexdigest()
                result[field + '_size'] = list(image.size)
            assert result['image_size'] == result['mask_size']
            print('downloaded', identifier, flush=True)
            return result

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            records = list(pool.map(fetch, indices))
        assert len({row['image_sha256'] for row in records}) == 30
        manifest = {'dataset': DATASET, 'split': SPLIT, 'selection': '30 evenly spaced rows from 0..499, selected before inference; no replacements',
                    'original_project': 'https://github.com/JizhiziLi/P3M',
                    'agreement': 'https://jizhizili.github.io/files/p3m_dataset_agreement/P3M-10k_Dataset_Release_Agreement.pdf',
                    'citation': 'Li, Jizhizi, Sihan Ma, Jing Zhang, and Dacheng Tao. Privacy-Preserving Portrait Matting. ACM MM, 2021.',
                    'license': 'MIT dataset release; original photographs remain copyrighted by their owners', 'samples': records}
        manifest_file.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    if not args.run_name.replace('-', '').isalnum():
        raise ValueError('Invalid run name')
    compare = out / args.run_name
    if not (compare / 'report.json').exists():
        command = [sys.executable, str(ROOT / 'scripts/compare-matting.py'), '--model', 'MODNet=' + str(args.model), '--output', str(compare)]
        for row in manifest['samples']:
            command.extend(['--image', str(raw / (row['id'] + '-image.png'))])
        subprocess.run(command, check=True)
    report = json.loads((compare / 'report.json').read_text())
    samples = report['models'][0]['samples']
    assert len(samples) == 30
    results = []
    panels = []
    for i, (row, sample) in enumerate(zip(manifest['samples'], samples)):
        folder = compare / ('model-0-image-' + str(i))
        original = Image.open(raw / (row['id'] + '-image.png')).convert('RGB')
        original.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        gt = Image.open(raw / (row['id'] + '-mask.png')).convert('L').resize(original.size, Image.Resampling.BILINEAR)
        crop = sample['crop']
        transform = (crop['sw'] / 900, 0, crop['sx'], 0, crop['sh'] / 1200, crop['sy'])
        truth = gt.transform((900, 1200), Image.Transform.AFFINE, transform, Image.Resampling.BILINEAR)
        expected = np.asarray(truth, dtype=np.float32) / 255
        rendered = Image.frombytes('RGBA', (900, 1200), (folder / 'result.rgba').read_bytes())
        predicted = np.asarray(rendered)[:, :, 3].astype(np.float32) / 255
        difference = np.abs(predicted - expected)
        foreground = expected >= .95
        background = expected <= .05
        opaque = (expected > .5).astype(np.uint8)
        band = cv2.morphologyEx(opaque, cv2.MORPH_GRADIENT, np.ones((15, 15), np.uint8)) > 0
        foreground_loss = float(np.mean(predicted[foreground] < .5)) if foreground.any() else None
        background_leak = float(np.mean(predicted[background] > .5)) if background.any() else None
        boundary_mae = float(difference[band].mean()) if band.any() else None
        flags = []
        if sample['faces'] != 1:
            flags.append('multiple_faces_rejected' if sample['faces'] > 1 else 'no_face_center_crop_fallback')
        if foreground_loss is not None and foreground_loss > .05:
            flags.append('foreground_loss_over_5pct')
        if background_leak is not None and background_leak > .03:
            flags.append('background_leak_over_3pct')
        if boundary_mae is not None and boundary_mae > .20:
            flags.append('boundary_mae_over_0.20')
        item = {**row, 'faces_detected': sample['faces'], 'crop': crop,
                'alpha_mae': float(difference.mean()), 'boundary_mae': boundary_mae,
                'foreground_loss_fraction': foreground_loss, 'background_leak_fraction': background_leak,
                'inference_ms': sample['inference_ms'], 'flags': flags,
                'app_policy': 'reject_multiple_faces' if sample['faces'] > 1 else 'render_with_crop_warning' if not sample['faces'] else 'render',
                'manual_notes': 'not yet visually reviewed'}
        source = Image.frombytes('RGBA', (900, 1200), (folder / 'source.rgba').read_bytes())
        truth_rgba = source.copy()
        truth_rgba.putalpha(truth)
        images = {'original': ImageOps.contain(Image.open(raw / (row['id'] + '-image.png')).convert('RGB'), (320, 360)),
                  'blue': rendered, 'white': rendered, 'ground_truth': truth_rgba}
        panel = Image.new('RGB', (1000, 420), 'white')
        draw = ImageDraw.Draw(panel)
        for j, key in enumerate(images):
            image = images[key]
            if key != 'original':
                composite = Image.new('RGBA', image.size, '#438edb' if key == 'blue' else 'white')
                composite.alpha_composite(image)
                image = composite.convert('RGB')
            thumbnail = ImageOps.contain(image, (240, 340))
            panel.paste(thumbnail, (j * 250 + (250 - thumbnail.width) // 2, 45))
            draw.text((j * 250 + 8, 25), key.upper(), fill='black')
            image.save(folder / (key + '-review.jpg'), quality=90)
        draw.text((8, 5), '%s | faces=%d | MAE=%.4f | fg_loss=%.1f%% | bg_leak=%.1f%%' %
                  (row['id'], sample['faces'], item['alpha_mae'], 100 * (foreground_loss or 0), 100 * (background_leak or 0)), fill='black')
        draw.text((8, 397), 'FLAGS: ' + (', '.join(flags) or 'none (not a quality pass)'), fill='black')
        panel.save(folder / 'review.jpg', quality=90)
        panels.append(panel)
        results.append(item)
    for offset in range(0, 30, 5):
        page = Image.new('RGB', (1000, 420 * 5), 'white')
        for j, panel in enumerate(panels[offset:offset + 5]):
            page.paste(panel, (0, j * 420))
        page.save(out / ('contact-' + str(offset // 5 + 1) + '.jpg'), quality=90)
    times = [value for item in results for value in item['inference_ms']]
    summary = {'photos_downloaded': 30, 'photos_evaluated': len(results),
               'single_face': sum(r['faces_detected'] == 1 for r in results),
               'no_face': sum(r['faces_detected'] == 0 for r in results),
               'multiple_faces': sum(r['faces_detected'] > 1 for r in results),
               'mean_alpha_mae': statistics.mean(r['alpha_mae'] for r in results),
               'median_alpha_mae': statistics.median(r['alpha_mae'] for r in results),
               'mean_boundary_mae': statistics.mean(r['boundary_mae'] for r in results if r['boundary_mae'] is not None),
               'inference_median_ms': statistics.median(times), 'inference_p95_ms': float(np.percentile(times, 95)),
               'heuristic_flagged': sum(bool(r['flags']) for r in results)}
    final = {'summary': summary, 'model_sha256': EXPECTED_MODEL, 'source': manifest,
             'run_folder': args.run_name,
             'runtime_versions': {'onnxruntime': report['onnxruntime'], 'numpy': np.__version__, 'opencv': cv2.__version__},
             'metric_scope': 'Alpha metrics on the actual app final 900x1200 crop, using the same source crop for prediction and ground truth. This does not score crop suitability, RGB edge colors, or accuracy over the original full body. All 30 retained, including app-rejected multi-face cases.',
             'thresholds': 'Heuristics fixed before scoring: foreground alpha loss >5%, background opacity leak >3%, boundary alpha MAE >0.20. Flags are review aids, not benchmark pass/fail or certification.',
             'runtime_scope': 'Local Windows CPU, warm ONNX inference only, 3 timed runs per photo; no network/cloud moderation/phone/ECS load tests. Offline previews are for evaluation only.',
             'samples': results}
    (out / 'evaluation.json').write_text(json.dumps(final, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == '__main__':
    main()
