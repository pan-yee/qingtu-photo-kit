"""Freeze visually screened indoor photos and compare bounded resolution candidates.

COCO polygons are coarse segmentation, not hair alpha ground truth. Evaluate only
eroded foreground/background interiors. Diagnostic mattes never bypass app gates.
"""
import argparse
import base64
from collections import Counter
import io
import json
from pathlib import Path
import random
import sys
import time
import cv2
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend/matting'))
import server
from framing import detect_faces, portrait_region, validate_face, PortraitInputError
from matte_cleanup import clean_matte

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('output', type=Path)
args = p.parse_args()
out = args.output
manifest = out / 'sources.json'
annotations = json.loads((out / 'instances_val2017.json').read_text(encoding='utf-8'))
by_image = {}
for ann in annotations['annotations']:
    by_image.setdefault(ann['image_id'], []).append(ann)
if not manifest.exists():
    # Checked all six candidate contact sheets before running any matting.
    exclude = {0,8,12,13,16,17,18,20,22,24,25,27,30,33,36,42,46,55,58,59,60,68,71,73,78,79,82,83,90,92,94,96,98,99,108,111,115,118,120,123,124,128,129,133,135,136,139,142,147,149,150,157,159,160,161,163,166,170,178}
    candidates = json.loads((out / 'candidates.json').read_text(encoding='utf-8'))
    eligible = [{**r, 'candidate_index': i} for i, r in enumerate(candidates) if i not in exclude and r['download_status'] == 'ok']
    # Require annotated people as well as a visually verified indoor setting.
    eligible = [r for r in eligible if any(a['category_id'] == 1 for a in by_image.get(r['image_id'], []))]
    rows = random.Random(20261113101).sample(eligible, 100)
    assert len({r['image_sha256'] for r in rows}) == 100
    for i, row in enumerate(rows):
        row['partition'] = 'tune' if i < 60 else 'holdout'
        row['scene'] = '/'.join(row['scene_tags'])
    manifest.write_text(json.dumps({'selection': 'Caption screening, manual inspection of 180 candidates, exclude outdoor/no-person/scene mismatch, then seed 20261113101 sample 100 unique real photos before matting. First 60 tune, final 40 holdout.', 'licenses': annotations['licenses'], 'samples': rows}, indent=2), encoding='utf-8')
rows = json.loads(manifest.read_text(encoding='utf-8'))['samples']

def polygon_mask(image, anns):
    result = Image.new('L', image.size)
    draw = ImageDraw.Draw(result)
    for ann in anns:
        polygons = ann['segmentation']
        if not isinstance(polygons, list):
            continue  # Crowd RLE excluded from this coarse quality comparison.
        for poly in polygons:
            draw.polygon(list(zip(poly[::2], poly[1::2])), fill=255)
    return result

def infer(image, short):
    w, h = image.size
    scale = min(short/min(w,h), (1024 if short <= 512 else 1280)/max(w,h))
    size = (max(32,int(w*scale)//32*32), max(32,int(h*scale)//32*32))
    values = (np.asarray(image.resize(size, Image.Resampling.BOX), dtype=np.float32)-127.5)/127.5
    start = time.perf_counter()
    alpha = server.session.run(None, {server.session.get_inputs()[0].name: values.transpose(2,0,1)[None]})[0].squeeze()
    return np.clip(alpha,0,1), (time.perf_counter()-start)*1000

report = []
for index, row in enumerate(rows):
    folder = out / 'diagnostic' / row['id']
    folder.mkdir(parents=True, exist_ok=True)
    cached = folder / 'metrics.json'
    if cached.exists():
        report.append(json.loads(cached.read_text(encoding='utf-8')))
        continue
    image = Image.open(out / 'dataset' / (row['id']+'-image.png')).convert('RGB')
    faces = detect_faces(image)
    status = 'eligible'
    try:
        validate_face(image, faces)
    except PortraitInputError as e:
        status = e.code
    focused, region = portrait_region(image, faces)
    anns = [a for a in by_image[row['image_id']] if a['category_id'] == 1 and not a['iscrowd']]
    if len(faces) == 1:
        fx,fy = (faces[0]['x']+faces[0]['width']/2)*image.width, (faces[0]['y']+faces[0]['height']/2)*image.height
        containing = [a for a in anns if a['bbox'][0]<=fx<=a['bbox'][0]+a['bbox'][2] and a['bbox'][1]<=fy<=a['bbox'][1]+a['bbox'][3]]
        if containing:
            anns = [min(containing, key=lambda a:a['area'])]
    truth = polygon_mask(image, anns)
    if region:
        x,y=round(region['x']*image.width),round(region['y']*image.height)
        truth=truth.crop((x,y,x+focused.width,y+focused.height))
    # Same grid and margin for every candidate; no scoring ambiguous hair edges.
    grid=(512,512)
    gt=np.asarray(truth.resize(grid,Image.Resampling.NEAREST))>127
    kernel=np.ones((11,11),np.uint8)
    fg=cv2.erode(gt.astype(np.uint8),kernel)>0
    bg=cv2.erode((~gt).astype(np.uint8),kernel)>0
    metrics={}
    for short in (512,384,640):
        alpha,ms=infer(focused,short)
        if len(faces)==1:
            alpha=clean_matte(alpha,faces[0],region)
        evaluated=cv2.resize(alpha,grid,interpolation=cv2.INTER_LINEAR)
        metrics[str(short)]={'background_residual':float(evaluated[bg].mean()) if bg.any() else None,
                             'foreground_loss':float((1-evaluated[fg]).mean()) if fg.any() else None,
                             'inference_ms':round(ms,2)}
        rgba=focused.resize((alpha.shape[1],alpha.shape[0])).convert('RGBA')
        rgba.putalpha(Image.fromarray(np.rint(alpha*255).astype(np.uint8)))
        for name,color in [('blue','#438edb'),('white','#ffffff')]:
            canvas=Image.new('RGBA',rgba.size,color);canvas.alpha_composite(rgba);canvas.convert('RGB').save(folder/f'{short}-{name}.jpg',quality=90)
    record={'id':row['id'],'partition':row['partition'],'input_gate':status,'faces':len(faces),'metrics':metrics}
    cached.write_text(json.dumps(record,indent=2),encoding='utf-8');report.append(record)
    print(index+1,row['id'],status,flush=True)
summary={}
for partition in ['tune','holdout']:
    paired=[r for r in report if r['partition']==partition and all(m['background_residual'] is not None and m['foreground_loss'] is not None for m in r['metrics'].values())]
    summary[partition]={'paired_count':len(paired),'candidates':{str(s):{k:float(np.mean([r['metrics'][str(s)][k] for r in paired])) for k in ['background_residual','foreground_loss','inference_ms']} for s in [512,384,640]}}
result={'count':len(report),'input_gates':dict(Counter(r['input_gate'] for r in report)), 'scope':'Diagnostic regional mattes on all 100, including app-rejected inputs. COCO coarse polygons with 5px excluded boundary on 512 grid; NOT fine-hair alpha ground truth or ID generation success.', 'summary':summary,'samples':report}
(out/'experiment.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps(summary),flush=True)
