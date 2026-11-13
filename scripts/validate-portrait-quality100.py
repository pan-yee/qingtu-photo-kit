"""Paired actual production-gated renders, pinned old/new frontend modules.

Never replace rejected inputs or treat coarse COCO polygons as fine-hair truth.
Downloads only the frozen manifest; checks original bytes against its SHA256.
"""
import argparse
import base64
from collections import Counter
import hashlib
import html
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request

import numpy as np
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest', type=Path, default=ROOT / 'docs/validation/clutter100-sources.json')
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--baseline-ref', default='336d041')
    p.add_argument('--download', action='store_true')
    p.add_argument('--expected-count', type=int, default=100)
    args = p.parse_args()
    manifest = json.loads(args.manifest.read_text())
    rows = manifest['samples']
    if len(rows) != args.expected_count or len({r['image_sha256'] for r in rows}) != len(rows):
        p.error('Expected the requested count of unique frozen images')
    if len({r['id'] for r in rows}) != len(rows) or any(not re.fullmatch(r'[a-zA-Z0-9_-]+', r['id']) for r in rows):
        p.error('Invalid or duplicate sample IDs')
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    dataset = out / 'dataset'
    dataset.mkdir(exist_ok=True)
    # Resolve revisions before any evaluation. Worktree changes are recorded too.
    baseline_sha = subprocess.check_output(['git', 'rev-parse', '--verify', args.baseline_ref + '^{commit}'], cwd=ROOT, text=True).strip()
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    modules = {}
    for version, ref in [('before', baseline_sha), ('after', None)]:
        modules[version] = {}
        for key, filename in [('framingPath', 'portrait-framing.js'), ('rendererPath', 'portrait-segmentation.js')]:
            path = 'frontend/miniprogram/utils/' + filename
            content = subprocess.check_output(['git', 'show', f'{ref}:{path}'], cwd=ROOT) if ref else (ROOT / path).read_bytes()
            dest = out / f'{version}-{filename}.cjs'
            dest.write_bytes(content)
            modules[version][key] = str(dest)
    report = {'baseline_ref': baseline_sha, 'candidate_head': head,
              'module_sha256': {v: {k: hashlib.sha256(Path(path).read_bytes()).hexdigest() for k, path in paths.items()} for v, paths in modules.items()},
              'manifest_sha256': hashlib.sha256(args.manifest.read_bytes()).hexdigest(),
              'worker_sha256': {name: hashlib.sha256((ROOT / 'backend/matting' / name).read_bytes()).hexdigest() for name in ['server.py', 'framing.py', 'matte_cleanup.py']},
              'requested_count': len(rows), 'samples': [],
              'scope': 'Offline actual worker gates, same worker matte for unchanged backend, actual old/new frontend framing/render. Blue and white outputs. No fine alpha/RGB truth: differences are not quality scores. Rejections and errors retained. No ECS/phone/moderation validation.'}
    bridge = ROOT / 'frontend/scripts/matting-pixels.js'

    def save_report():
        report['processed_count'] = len(report['samples'])
        report['summary'] = dict(Counter(r['status'] for r in report['samples']))
        report['rejection_reasons'] = dict(Counter(r['code'] for r in report['samples'] if r['status'] == 'rejected'))
        report['complete'] = len(report['samples']) == len(rows)
        (out / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')

    save_report()
    sys.path.insert(0, str(ROOT / 'backend/matting'))
    # Production import checks model hash and detector, never substitutes models.
    try:
        import server
        from framing import PortraitInputError
    except Exception as error:
        report['preflight_error'] = {'type': type(error).__name__, 'message': str(error)}
        save_report()
        raise
    cards = []
    for row in rows:
        dest = out / row['id']
        dest.mkdir(exist_ok=True)
        record = {'id': row['id'], 'scene_tags': row.get('scene_tags', []), 'source': row['source']}
        start = time.perf_counter()
        try:
            raw_path = dataset / (row['id'] + '.original')
            if not raw_path.exists() and args.download:
                # Use HTTPS for COCO sources; bytes must still match frozen hash.
                url = row['source'].replace('http://', 'https://', 1)
                with urllib.request.urlopen(url, timeout=45) as response:
                    content = response.read()
                if hashlib.sha256(content).hexdigest() != row['image_sha256']:
                    raise ValueError('Original download SHA256 mismatch')
                raw_path.write_bytes(content)
            raw = raw_path.read_bytes()
            if hashlib.sha256(raw).hexdigest() != row['image_sha256']:
                raise ValueError('Cached original SHA256 mismatch')
            image = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert('RGB')
            image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
            image.save(dest / 'original.jpg', quality=92)
            upload = io.BytesIO()
            image.save(upload, 'PNG')
            result = server.matte_image(upload.getvalue())
            (dest / 'worker-mask.png').write_bytes(base64.b64decode(result['png']))
            (dest / 'worker-metadata.json').write_text(json.dumps({k: v for k, v in result.items() if k != 'png'}, indent=2))
            alpha = np.asarray(Image.open(dest / 'worker-mask.png'), dtype=np.float32) / 255
            alpha.tofile(dest / 'mask.f32')
            frames = {}
            rendered = {}
            for version in ['before', 'after']:
                request = {'width': image.width, 'height': image.height, 'face': result['faces'][0], 'region': result['region'],
                           'maskPath': str(dest / 'mask.f32'), 'maskWidth': result['width'], 'maskHeight': result['height'],
                           'output': str(dest / (version + '-frame')), **modules[version]}
                request_path = dest / (version + '-frame-request.json')
                request_path.write_text(json.dumps(request))
                subprocess.run(['node', str(bridge), 'frame', str(request_path)], check=True, capture_output=True)
                frame = json.loads((dest / (version + '-frame.json')).read_text())
                frames[version] = frame
                if not frame['validCrop']:
                    raise PortraitInputError('MATTING_INVALID_CROP')
                crop = frame['crop']
                source = image.convert('RGBA').transform((900, 1200), Image.Transform.AFFINE,
                    (crop['sw']/900, 0, crop['sx'], 0, crop['sh']/1200, crop['sy']), Image.Resampling.BILINEAR)
                source_path = dest / (version + '-source.rgba')
                source_path.write_bytes(source.tobytes())
                request = {'maskPath': str(dest / (version + '-frame.f32')), 'maskWidth': frame['width'], 'maskHeight': frame['height'],
                           'imagePath': str(source_path), 'output': str(dest / (version + '.rgba')), **modules[version]}
                request_path = dest / (version + '-render-request.json')
                request_path.write_text(json.dumps(request))
                subprocess.run(['node', str(bridge), 'render', str(request_path)], check=True, capture_output=True)
                rgba = Image.frombytes('RGBA', (900, 1200), (dest / (version + '.rgba')).read_bytes())
                rendered[version] = np.asarray(rgba).astype(np.float32)
                for name, color in [('blue', '#438edb'), ('white', '#ffffff')]:
                    canvas = Image.new('RGBA', rgba.size, color)
                    canvas.alpha_composite(rgba)
                    canvas.convert('RGB').save(dest / f'{version}-{name}.jpg', quality=92)
            before, after = rendered['before'], rendered['after']
            rgb_delta = np.abs(after[:, :, :3] - before[:, :, :3])
            opaque = (before[:, :, 3] == 255) & (after[:, :, 3] == 255)
            record.update(status='rendered', frames=frames,
                differences={'alpha_mae_0_255': float(np.abs(after[:, :, 3] - before[:, :, 3]).mean()),
                             'rgb_mae_0_255': float(rgb_delta.mean()),
                             'opaque_rgb_changed_pixels': int(((rgb_delta.max(axis=2) > 0) & opaque).sum())})
        except PortraitInputError as error:
            record.update(status='rejected', code=error.code)
        except Exception as error:
            record.update(status='error', error_type=type(error).__name__, message=str(error))
        finally:
            for temporary in list(dest.glob('*.f32')) + list(dest.glob('*.rgba')):
                temporary.unlink()
        # Always overwrite panel; rejected/error inputs never show stale outputs.
        panel = Image.new('RGB', (1250, 400), 'white')
        draw = ImageDraw.Draw(panel)
        views = [('original', 'original.jpg'), ('before blue', 'before-blue.jpg'), ('after blue', 'after-blue.jpg'),
                 ('before white', 'before-white.jpg'), ('after white', 'after-white.jpg')]
        for index, (label, filename) in enumerate(views):
            draw.text((index*250+4, 5), label, fill='black')
            path = dest / filename
            if path.exists() and (index == 0 or record['status'] == 'rendered'):
                thumb = ImageOps.contain(Image.open(path), (242, 355))
                panel.paste(thumb, (index*250+(250-thumb.width)//2, 30))
        draw.text((4, 385), row['id']+' | '+record['status']+' | '+record.get('code', record.get('error_type', '')), fill='black')
        panel.save(dest / 'comparison.jpg', quality=90)
        record['elapsed_ms'] = round((time.perf_counter()-start)*1000, 2)
        report['samples'].append(record)
        save_report()
        cards.append(f'<section><h2>{html.escape(row["id"])} — {html.escape(record["status"])}</h2><a href="{row["id"]}/comparison.jpg"><img loading="lazy" src="{row["id"]}/comparison.jpg" width="1250"></a></section>')
        print(len(report['samples']), row['id'], record['status'], flush=True)
    page = '<!doctype html><meta charset="utf-8"><title>Portrait quality paired review</title><style>body{font-family:sans-serif;margin:24px}img{max-width:100%;height:auto}section{border-top:1px solid #bbb}</style><h1>100-input paired review</h1><p>Original / before blue / after blue / before white / after white. Rejected inputs are not successful ID photos. Pixel differences do not prove quality improvement.</p>' + ''.join(cards)
    (out / 'review.html').write_text(page, encoding='utf-8')
    print(json.dumps(report['summary']))
    if report['summary'].get('error'):
        sys.exit(1)


if __name__ == '__main__':
    main()
