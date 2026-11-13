"""Download a fresh fixed 30-photo P3M sample and cache raw production mattes.

Ground truth is used only for evaluation, never as input to a candidate algorithm.
Rejected ID inputs remain in the report; raw matting is diagnostic, not app success.
"""
import argparse
import concurrent.futures
import hashlib
import io
import json
import os
import random
from pathlib import Path
import sys
import time
import urllib.parse
import urllib.request

import cv2
import numpy as np
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend/matting'))


def download(url):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                return response.read()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--prepared', action='store_true', help='Use a separately recorded, pre-screened 30-photo manifest')
    parser.add_argument('--count', type=int, default=30)
    parser.add_argument('--seed', type=int, help='Select a reproducible random sample before inference')
    args = parser.parse_args()
    out = args.output.resolve()
    raw = out / 'dataset'
    raw.mkdir(parents=True, exist_ok=True)
    # Fixed before model execution, disjoint from the 2026-11-11 sample.
    if not 1 <= args.count <= 500:
        parser.error('count must be 1..500')
    previous = {round(i * 499 / 29) for i in range(30)}
    indices = random.Random(args.seed).sample(range(500), args.count) if args.seed is not None else [i for i in range(5, 500, 15) if i not in previous][:args.count]
    assert len(indices) == args.count
    manifest_path = out / 'sources.json'
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        assert len(manifest['samples']) == args.count
        if not args.prepared:
            assert [s['row_index'] for s in manifest['samples']] == indices
    else:
        selected = {}
        for offset in range(0, 500, 100):
            query = urllib.parse.urlencode(dict(dataset='nobg/P3M-10K', config='default', split='P3M_500_NP', offset=offset, length=100))
            page = json.loads(download('https://datasets-server.huggingface.co/rows?' + query))
            selected.update({r['row_idx']: r['row'] for r in page['rows'] if r['row_idx'] in indices})

        def fetch(index):
            row = selected[index]
            identifier = f'p3m-np-{index:03d}'
            record = {'id': identifier, 'row_index': index,
                      'source': f'https://huggingface.co/datasets/nobg/P3M-10K/viewer/default/P3M_500_NP?row={index}'}
            for field in ['image', 'mask']:
                content = download(row[field]['src'])
                image = Image.open(io.BytesIO(content))
                original_size = list(image.size)
                image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
                image.convert('RGB' if field == 'image' else 'L').save(raw / f'{identifier}-{field}.png')
                record[field + '_sha256'] = hashlib.sha256(content).hexdigest()
                record[field + '_size'] = original_size
                record[field + '_local_size'] = list(image.size)
            print('downloaded', identifier, flush=True)
            return record

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            records = list(pool.map(fetch, indices))
        assert len({s['image_sha256'] for s in records}) == args.count
        manifest = {'dataset': 'nobg/P3M-10K', 'split': 'P3M_500_NP',
                    'selection': f'Random sample without replacement, seed={args.seed}, count={args.count}, selected before inference; no replacement for failures.' if args.seed is not None else 'Fixed rows from range(5,500,15), excluding previous 30. No replacement for failures.',
                    'project': 'https://github.com/JizhiziLi/P3M',
                    'agreement': 'https://jizhizili.github.io/files/p3m_dataset_agreement/P3M-10k_Dataset_Release_Agreement.pdf',
                    'samples': records}
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')

    from framing import detect_faces, portrait_region, validate_face, validate_matte, PortraitInputError
    import server
    records = []
    for record in manifest['samples']:
        folder = out / record['id']
        folder.mkdir(exist_ok=True)
        if (folder / 'baseline.json').exists():
            records.append(json.loads((folder / 'baseline.json').read_text()))
            continue
        image = ImageOps.exif_transpose(Image.open(raw / (record['id'] + '-image.png'))).convert('RGB')
        image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        truth = Image.open(raw / (record['id'] + '-mask.png')).convert('L').resize(image.size, Image.Resampling.BILINEAR)
        faces = detect_faces(image)
        status, code = 'accepted', None
        try:
            validate_face(image, faces)
        except PortraitInputError as error:
            status, code = 'rejected', error.code
        region_image, region = portrait_region(image, faces)
        width, height = region_image.size
        scale = min(512 / min(width, height), 1024 / max(width, height))
        size = (max(32, int(width * scale) // 32 * 32), max(32, int(height * scale) // 32 * 32))
        rgb = np.asarray(region_image.resize(size, Image.Resampling.BOX), dtype=np.float32)
        tensor = ((rgb - 127.5) / 127.5).transpose(2, 0, 1)[None]
        started = time.perf_counter()
        alpha = server.session.run(None, {server.session.get_inputs()[0].name: tensor})[0].squeeze()
        elapsed = (time.perf_counter() - started) * 1000
        if status == 'accepted':
            try:
                validate_matte(alpha, faces[0], region)
            except PortraitInputError as error:
                status, code = 'rejected', error.code
        if region:
            left, top = round(region['x'] * image.width), round(region['y'] * image.height)
            truth = truth.crop((left, top, left + width, top + height))
        region_image.save(folder / 'source.png')
        truth.save(folder / 'truth.png')
        np.save(folder / 'baseline.npy', np.clip(alpha, 0, 1))
        data = {**record, 'status': status, 'code': code, 'faces': faces, 'region': region,
                'input_size': list(image.size), 'region_size': [width, height], 'mask_size': list(size),
                'inference_ms': round(elapsed, 2)}
        (folder / 'baseline.json').write_text(json.dumps(data, indent=2))
        records.append(data)
        print(record['id'], status, code or '', flush=True)
    (out / 'baseline.json').write_text(json.dumps({'samples': records}, indent=2))
    print('baseline complete:', len(records), flush=True)


if __name__ == '__main__':
    main()
