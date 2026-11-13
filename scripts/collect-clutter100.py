"""Collect real COCO indoor people, retaining captions, licenses and selection evidence.

This does not composite synthetic rooms or use model output to choose photographs.
"""
import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import random
import re
import sys
import time
import urllib.parse
import urllib.request
from PIL import Image, ImageOps, ImageDraw

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
(out / 'dataset').mkdir(exist_ok=True)

def get(url):
    for attempt in range(3):
        try:
            return urllib.request.urlopen(url, timeout=60).read()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)

def page(offset):
    query = urllib.parse.urlencode(dict(dataset='phiyodr/coco2017', config='default', split='validation', offset=offset, length=100))
    return json.loads(get('https://datasets-server.huggingface.co/rows?' + query))['rows']

cache = out / 'metadata.json'
if cache.exists():
    rows = json.loads(cache.read_text(encoding='utf-8'))
else:
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        rows = [r for batch in pool.map(page, range(0, 5000, 100)) for r in batch]
    cache.write_text(json.dumps(rows), encoding='utf-8')

person = re.compile(r'\b(man|woman|person|people|boy|girl|child|men|women|baby)\b', re.I)
groups = {
    'sofa': r'\b(couch|sofa|living room)\b',
    'bedroom_clothes': r'\b(bedroom|bed|laundry|clothes|closet|blanket)\b',
    'kitchen_clutter': r'\b(kitchen|refrigerator|oven|stove)\b',
    'desk_objects': r'\b(desk|computer|laptop|office|book shelf|bookshelf)\b',
    'dining_objects': r'\b(dining|restaurant|table.*(plate|food)|plate.*table)\b',
}
candidates = []
for row in rows:
    captions = ' '.join(row['row']['captions'])
    tags = [name for name, pattern in groups.items() if re.search(pattern, captions, re.I)]
    if tags and person.search(captions):
        candidates.append({**row, 'scene_tags': tags})
random.Random(20261113100).shuffle(candidates)
# Pre-screen a larger pool visually; freeze the final 100 before matting.
candidates = candidates[:180]

def download(row):
    r = row['row']
    path = out / 'dataset' / (f"coco-{r['image_id']:012d}-image.png")
    record = {'id': f"coco-{r['image_id']:012d}", 'row_index': row['row_idx'], 'image_id': r['image_id'],
              'source': r['coco_url'], 'flickr_url': r['flickr_url'],
              'license_id': r['license'], 'captions': r['captions'], 'scene_tags': row['scene_tags']}
    sidecar = path.with_suffix('.json')
    if sidecar.exists():
        previous = json.loads(sidecar.read_text(encoding='utf-8'))
        if previous.get('download_status') == 'ok':
            return previous
    try:
        raw = get(record['source'])
        image = Image.open(io.BytesIO(raw)).convert('RGB')
        record['original_size'] = list(image.size)
        image.save(path)
        record['image_sha256'] = hashlib.sha256(raw).hexdigest()
        record['download_status'] = 'ok'
    except Exception as error:
        record['download_status'] = type(error).__name__
    sidecar.write_text(json.dumps(record, indent=2), encoding='utf-8')
    return record

with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    records = []
    for n, r in enumerate(pool.map(download, candidates)):
        records.append(r)
        if n % 20 == 19:
            print('candidates downloaded', n + 1, flush=True)
(out / 'candidates.json').write_text(json.dumps(records, indent=2), encoding='utf-8')
for start in range(0, len(records), 30):
    panel = Image.new('RGB', (1500, 1500), 'white')
    draw = ImageDraw.Draw(panel)
    for n, row in enumerate(records[start:start + 30]):
        x, y = n % 5 * 300, n // 5 * 250
        draw.text((x + 3, y + 3), f"{start+n:03d} {row['id']} {'/'.join(row['scene_tags'])}", fill='black')
        path = out / 'dataset' / (row['id'] + '-image.png')
        if path.exists():
            im = ImageOps.contain(Image.open(path), (294, 215))
            panel.paste(im, (x + (300-im.width)//2, y + 28))
    panel.save(out / f'candidates-{start//30}.jpg', quality=90)
print('ready', len(records), flush=True)
