"""Compare actual old/new worker mattes and actual frontend renderers.

The 30-photo set is a development regression set, not a general quality ranking.
All metrics use the same source region / annotated alpha, independently of crop.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
import numpy as np
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend/matting'))
from matte_cleanup import clean_matte


def scores(prediction, truth):
    background = truth < .01
    foreground = truth > .99
    return {'alpha_mae': float(np.abs(prediction - truth).mean()),
            'background_opacity': float(prediction[background].mean()) if background.any() else None,
            'foreground_opacity_loss': float((1 - prediction[foreground]).mean()) if foreground.any() else None,
            'opaque_background_fraction': float((prediction[background] > .5).mean()) if background.any() else None}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input', type=Path, required=True)
    p.add_argument('--node', default='node')
    p.add_argument('--baseline-ref', default='efbaa31', help='Pinned pre-fix Git revision, not the working tree')
    args = p.parse_args()
    folder = args.input.resolve()
    data = json.loads((folder / 'baseline.json').read_text())
    baseline_renderer = folder / 'baseline-renderer.cjs'
    baseline_renderer.write_bytes(subprocess.run(['git', 'show', args.baseline_ref + ':frontend/miniprogram/utils/portrait-segmentation.js'], cwd=ROOT, check=True, capture_output=True).stdout)
    bridge = ROOT / 'frontend/scripts/matting-pixels.js'
    records = []
    for row in data['samples']:
        item = folder / row['id']
        raw_alpha = np.load(item / 'baseline.npy')
        alpha = np.rint(np.clip(raw_alpha, 0, 1) * 255) / 255
        start = time.perf_counter()
        fixed = clean_matte(raw_alpha, row['faces'][0] if len(row['faces']) == 1 else None, row['region'])
        fixed = np.rint(np.clip(fixed, 0, 1) * 255) / 255
        cleanup_ms = (time.perf_counter() - start) * 1000
        rgb = Image.open(item / 'source.png').convert('RGB')
        truth = np.asarray(Image.open(item / 'truth.png').resize((alpha.shape[1], alpha.shape[0]), Image.Resampling.BILINEAR), np.float32) / 255
        record = {**row, 'cleanup_ms': round(cleanup_ms, 3), 'metrics': {}}
        for tolerance in [12, 36, 82]:
            before = np.clip(alpha + (36 - tolerance) / 150, 0, 1)
            scale = 2 ** ((tolerance - 36) / 24)
            after = fixed / (fixed + (1 - fixed) * scale)
            record['metrics'][str(tolerance)] = {'before': scores(before, truth), 'after': scores(after, truth)}
        # Actual final crop and actual frontend alpha/color code, not fabricated output.
        complete = Image.open(folder / 'dataset' / (row['id'] + '-image.png')).convert('RGB')
        complete.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        record['renders'] = {}
        if row['status'] == 'accepted':
            for version, matte in [('before', alpha), ('after', fixed)]:
                matte.astype(np.float32).tofile(item / (version + '.f32'))
                metadata = {'width': complete.width, 'height': complete.height, 'face': row['faces'][0], 'region': row['region'],
                            'maskPath': str(item / (version + '.f32')), 'maskWidth': alpha.shape[1], 'maskHeight': alpha.shape[0],
                            'output': str(item / (version + '-frame'))}
                request = item / (version + '-frame-request.json')
                request.write_text(json.dumps(metadata))
                subprocess.run([args.node, str(bridge), 'frame', str(request)], check=True)
                frame = json.loads((item / (version + '-frame.json')).read_text())
                if not frame['validCrop']:
                    record['renders'][version] = {'status': 'invalid_crop'}
                    continue
                crop = frame['crop']
                transform = (crop['sw'] / 900, 0, crop['sx'], 0, crop['sh'] / 1200, crop['sy'])
                source = complete.convert('RGBA').transform((900, 1200), Image.Transform.AFFINE, transform, Image.Resampling.BILINEAR)
                source_path = item / (version + '-source.rgba')
                source_path.write_bytes(source.tobytes())
                for tolerance in [12, 36, 82]:
                    target = item / (version + f'-{tolerance}.rgba')
                    render = {'maskPath': str(item / (version + '-frame.f32')), 'maskWidth': frame['width'], 'maskHeight': frame['height'],
                              'imagePath': str(source_path), 'output': str(target), 'options': {'tolerance': tolerance}}
                    if version == 'before':
                        render['rendererPath'] = str(baseline_renderer)
                    request = item / (version + '-render-request.json')
                    request.write_text(json.dumps(render))
                    subprocess.run([args.node, str(bridge), 'render', str(request)], check=True)
                    rgba = Image.frombytes('RGBA', (900, 1200), target.read_bytes())
                    for name, color in [('blue', '#438edb'), ('white', '#ffffff')]:
                        composite = Image.new('RGBA', rgba.size, color)
                        composite.alpha_composite(rgba)
                        composite.convert('RGB').save(item / f'{version}-{tolerance}-{name}.jpg', quality=92)
                    target.unlink()
                record['renders'][version] = {'status': 'rendered', 'crop': crop}
                source_path.unlink()
        # Comparison panel shows default blue, edge-retention failure, and white.
        panel = Image.new('RGB', (1500, 460), 'white')
        draw = ImageDraw.Draw(panel)
        views = [('ORIGINAL', complete), ('BEFORE default', item / 'before-36-blue.jpg'), ('AFTER default', item / 'after-36-blue.jpg'),
                 ('BEFORE keep-more', item / 'before-12-blue.jpg'), ('AFTER keep-more', item / 'after-12-blue.jpg'), ('AFTER white', item / 'after-36-white.jpg')]
        for col, (label, value) in enumerate(views):
            draw.text((col * 250 + 6, 25), label, fill='black')
            if isinstance(value, Path) and not value.exists():
                draw.text((col * 250 + 6, 180), 'REJECTED / INVALID CROP', fill='black')
                continue
            photo = Image.open(value) if isinstance(value, Path) else value.copy()
            thumb = ImageOps.contain(photo, (240, 390))
            panel.paste(thumb, (col * 250 + (250 - thumb.width) // 2, 55))
        draw.text((6, 5), row['id'] + ' | ' + row['status'] + ' | default / keep-more (12) are different control settings', fill='black')
        panel.save(item / 'comparison.jpg', quality=90)
        records.append(record)
        print(row['id'], {k: v['status'] for k, v in record['renders'].items()}, flush=True)
    summary = {}
    accepted = [r for r in records if r['status'] == 'accepted']
    for tolerance in ['12', '36', '82']:
        summary[tolerance] = {}
        for version in ['before', 'after']:
            summary[tolerance][version] = {key: float(np.mean([r['metrics'][tolerance][version][key] for r in accepted
                                                            if r['metrics'][tolerance][version][key] is not None]))
                                           for key in accepted[0]['metrics'][tolerance][version]}
    report = {'baseline_ref': args.baseline_ref, 'sample_count': len(records), 'accepted_input_count': len(accepted), 'summary': summary,
              'rendered_before': sum(r['renders'].get('before', {}).get('status') == 'rendered' for r in records),
              'rendered_after': sum(r['renders'].get('after', {}).get('status') == 'rendered' for r in records),
              'scope': 'Offline development regression. Selected on existing input suitability gates, not mask quality. Source-region alpha metrics, paired same images; before/after each use actual frontend framing and render. No ECS/phone/network/cloud moderation verification.',
              'samples': records}
    (folder / 'comparison.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k != 'samples'}, indent=2), flush=True)


if __name__ == '__main__':
    main()
