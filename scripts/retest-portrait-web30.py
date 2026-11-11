"""Rerun the same 30 downloaded photos through the actual revised worker policy."""
import argparse
import base64
from collections import Counter
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import time
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend/matting'))
import server
from framing import PortraitInputError, FACE_DETECTOR


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    baseline = json.loads((args.baseline / 'evaluation.json').read_text(encoding='utf-8'))
    args.output.mkdir(parents=True, exist_ok=True)
    bridge = ROOT / 'frontend/scripts/matting-pixels.js'
    records = []
    panels = []
    for index, old in enumerate(baseline['samples']):
        folder = args.output / old['id']
        folder.mkdir(exist_ok=True)
        image = Image.open(args.baseline / 'dataset' / (old['id'] + '-image.png')).convert('RGB')
        image.thumbnail((1600,1600), Image.Resampling.LANCZOS)
        content = io.BytesIO(); image.save(content,format='PNG')
        started = time.perf_counter()
        record = {'id': old['id'], 'source': old['source'], 'row_index': old['row_index'],
                  'baseline_status': old['manual_status'], 'baseline_notes': old['manual_notes']}
        rendered = None
        try:
            result = server.matte_image(content.getvalue())
            assert result['protocol'] == 2 and result['faceDetector'] == FACE_DETECTOR and len(result['faces']) == 1
            mask = np.asarray(Image.open(io.BytesIO(base64.b64decode(result['png']))),dtype=np.float32)/255
            mask.tofile(folder/'mask.f32')
            metadata = {'width':image.width,'height':image.height,'face':result['faces'][0],'region':result['region'],
                        'maskPath':str(folder/'mask.f32'),'maskWidth':result['width'],'maskHeight':result['height'],
                        'output':str(folder/'framed')}
            (folder/'frame.json').write_text(json.dumps(metadata))
            subprocess.run(['node',str(bridge),'frame',str(folder/'frame.json')],check=True)
            frame = json.loads((folder/'framed.json').read_text())
            if not frame['validCrop']:
                raise PortraitInputError('MATTING_INVALID_CROP')
            crop=frame['crop']
            transform=(crop['sw']/900,0,crop['sx'],0,crop['sh']/1200,crop['sy'])
            source=image.convert('RGBA').transform((900,1200),Image.Transform.AFFINE,transform,Image.Resampling.BILINEAR)
            (folder/'source.rgba').write_bytes(source.tobytes())
            render={'maskPath':str(folder/'framed.f32'),'maskWidth':frame['width'],'maskHeight':frame['height'],
                    'imagePath':str(folder/'source.rgba'),'output':str(folder/'result.rgba')}
            (folder/'render.json').write_text(json.dumps(render))
            subprocess.run(['node',str(bridge),'render',str(folder/'render.json')],check=True)
            rendered=Image.frombytes('RGBA',(900,1200),(folder/'result.rgba').read_bytes())
            truth=Image.open(args.baseline/'dataset'/(old['id']+'-mask.png')).convert('L').resize(image.size,Image.Resampling.BILINEAR)
            truth=truth.transform((900,1200),Image.Transform.AFFINE,transform,Image.Resampling.BILINEAR)
            gt=np.asarray(truth,dtype=np.float32)/255
            predicted=np.asarray(rendered)[:,:,3].astype(np.float32)/255
            fg=gt>=.95;bg=gt<=.05
            record.update(status='rendered',face=result['faces'][0],crop=crop,alpha_mae=float(np.abs(gt-predicted).mean()),
                          foreground_loss=float((predicted[fg]<.5).mean()) if fg.any() else None,
                          background_leak=float((predicted[bg]>.5).mean()) if bg.any() else None)
            for name,color in [('blue','#438edb'),('white','white')]:
                composite=Image.new('RGBA',rendered.size,color);composite.alpha_composite(rendered)
                composite.convert('RGB').save(folder/(name+'.jpg'),quality=92)
        except PortraitInputError as error:
            record.update(status='rejected',code=error.code)
        record['worker_and_local_render_ms']=round((time.perf_counter()-started)*1000,2)
        records.append(record)
        panel=Image.new('RGB',(960,390),'white');draw=ImageDraw.Draw(panel)
        draw.text((8,5),old['id']+' | FIXED: '+record['status']+' '+record.get('code',''),fill='black')
        before=Image.open(args.baseline/baseline['run_folder']/('model-0-image-'+str(index))/'blue-review.jpg').convert('RGB')
        for col,(title,photo) in enumerate([('ORIGINAL',image),('BEFORE',before),('AFTER',Image.open(folder/'blue.jpg') if rendered else None)]):
            draw.text((col*320+8,25),title,fill='black')
            if photo:
                photo.thumbnail((300,325));panel.paste(photo,(col*320+(320-photo.width)//2,50))
            else:
                draw.text((col*320+10,160),'NO IMAGE GENERATED',fill='black')
                draw.text((col*320+10,185),record['code'],fill='black')
        panel.save(folder/'comparison.jpg',quality=90);panels.append(panel)
        print(old['id'],record['status'],record.get('code',''),flush=True)
    for i in range(0,30,5):
        contact=Image.new('RGB',(960,390*5),'white')
        for j,panel in enumerate(panels[i:i+5]):contact.paste(panel,(0,j*390))
        contact.save(args.output/('contact-'+str(i//5+1)+'.jpg'),quality=90)
    by_id={r['id']:r for r in records}
    blocked=['p3m-np-310','p3m-np-344','p3m-np-396','p3m-np-293']
    assert all(by_id[x]['status']=='rejected' for x in blocked), 'Known severe cases must not render'
    assert by_id['p3m-np-103']['status']=='rendered', 'False multiple-face rejection must be fixed'
    assert all(by_id[x]['status']=='rendered' for x in ['p3m-np-017','p3m-np-138','p3m-np-189','p3m-np-241','p3m-np-482']), 'Normal portrait regression'
    report={'summary':dict(Counter(r['status'] for r in records)),
            'rejection_reasons':dict(Counter(r['code'] for r in records if r['status']=='rejected')),
            'known_severe_cases_blocked':blocked,'false_multiple_face_sample_fixed':'p3m-np-103',
            'face_detector':FACE_DETECTOR,'samples':records,
            'scope':'Same 30 source photos and pinned worker dependencies. Real worker policy plus actual frontend framing/render code; no paid API, cloud moderation or ECS/phone latency measurement. Rejection is not reconstruction of the source. Not a formal ID compliance check.'}
    (args.output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k!='samples'},ensure_ascii=False),flush=True)


if __name__=='__main__':main()
