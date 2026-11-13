"""Pre-screen public images for one complete frontal face BEFORE matte inference.

Keep the original fixed 30 separately. The new benchmark fills 30 usable inputs,
not 30 guaranteed good results. Selection does not inspect alpha ground truth.
"""
import argparse
import concurrent.futures
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import sys
import urllib.parse
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend/matting'))
from framing import detect_faces, validate_face, PortraitInputError
spec = importlib.util.spec_from_file_location('evaluation', ROOT / 'scripts/evaluate-background30.py')
evaluation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluation)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--initial', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--worker-checked', action='store_true', help='Require existing full-head / face-alpha worker input checks, before quality assessment')
    args = p.parse_args()
    if args.worker_checked:
        import server
    raw = args.output / 'dataset'
    raw.mkdir(parents=True, exist_ok=True)
    if (args.output / 'sources.json').exists():
        print('Prepared manifest exists; not replacing samples')
        return
    initial = json.loads((args.initial / 'baseline.json').read_text())['samples']
    selected, screened = [], []
    # Input gates only. Never select on mask accuracy or background leakage.
    for old in initial:
        record = {k: v for k, v in old.items() if k not in ['status', 'code', 'faces', 'region', 'input_size', 'region_size', 'mask_size', 'inference_ms']}
        image = Image.open(args.initial / 'dataset' / (old['id'] + '-image.png')).convert('RGB')
        image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        if args.worker_checked and old['status'] != 'accepted':
            screened.append({'row_index': old['row_index'], 'code': old['code']})
            continue
        try:
            validate_face(image, detect_faces(image))
            if args.worker_checked:
                content = io.BytesIO()
                image.save(content, format='PNG')
                server.matte_image(content.getvalue())
        except PortraitInputError as error:
            screened.append({'row_index': old['row_index'], 'code': error.code})
            continue
        for field in ['image', 'mask']:
            shutil.copyfile(args.initial / 'dataset' / (old['id'] + '-' + field + '.png'), raw / (old['id'] + '-' + field + '.png'))
        selected.append(record)
        screened.append({'row_index': old['row_index'], 'code': 'selected'})
    rows = {}
    for offset in range(0, 500, 100):
        query = urllib.parse.urlencode(dict(dataset='nobg/P3M-10K', config='default', split='P3M_500_NP', offset=offset, length=100))
        page = json.loads(evaluation.download('https://datasets-server.huggingface.co/rows?' + query))
        rows.update({r['row_idx']: r['row'] for r in page['rows']})
    exclude = {r['row_index'] for r in initial} | {round(i * 499 / 29) for i in range(30)}
    order = [(11 + 37 * i) % 500 for i in range(500)]
    order = [i for i in order if i not in exclude]

    def screen(index):
        content = evaluation.download(rows[index]['image']['src'])
        original = Image.open(io.BytesIO(content)).convert('RGB')
        image = original.copy()
        image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        try:
            validate_face(image, detect_faces(image))
        except PortraitInputError as error:
            return index, None, error.code
        if args.worker_checked:
            buffer = io.BytesIO()
            image.save(buffer, format='PNG')
            try:
                with server.gate:
                    server.matte_image(buffer.getvalue())
            except PortraitInputError as error:
                return index, None, error.code
        return index, (content, original), 'input_gate_pass'

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for start in range(0, len(order), 8):
            if len(selected) >= 30:
                break
            for index, data, code in pool.map(screen, order[start:start + 8]):
                screened.append({'row_index': index, 'code': code})
                print('screened', index, code, flush=True)
                if not data or len(selected) >= 30:
                    continue
                content, image = data
                identifier = f'p3m-np-{index:03d}'
                record = {'id': identifier, 'row_index': index,
                          'source': f'https://huggingface.co/datasets/nobg/P3M-10K/viewer/default/P3M_500_NP?row={index}',
                          'image_sha256': hashlib.sha256(content).hexdigest(), 'image_size': list(image.size)}
                image.save(raw / (identifier + '-image.png'))
                content = evaluation.download(rows[index]['mask']['src'])
                truth = Image.open(io.BytesIO(content)).convert('L')
                truth.save(raw / (identifier + '-mask.png'))
                record.update(mask_sha256=hashlib.sha256(content).hexdigest(), mask_size=list(truth.size))
                selected.append(record)
                print('selected', identifier, len(selected), flush=True)
    assert len(selected) == 30
    manifest = {'dataset': 'nobg/P3M-10K', 'split': 'P3M_500_NP',
                'selection': ('Existing complete-head / opaque-inner-face input safety checks before quality assessment. ' if args.worker_checked else 'Complete single frontal face gate before matte inference. ') + 'First initial sample then deterministic (11+37*i)%500 order. No selection on quality metrics; input rejections retained in screened list.',
                'project': 'https://github.com/JizhiziLi/P3M',
                'agreement': 'https://jizhizili.github.io/files/p3m_dataset_agreement/P3M-10k_Dataset_Release_Agreement.pdf',
                'screened': screened, 'samples': selected}
    (args.output / 'sources.json').write_text(json.dumps(manifest, indent=2))
    print('30 usable face inputs selected', flush=True)


if __name__ == '__main__':
    main()
