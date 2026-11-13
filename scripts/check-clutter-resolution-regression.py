"""Check candidate resolutions against existing independent fine-alpha samples."""
import argparse
import importlib.util
import io
import json
from pathlib import Path
import sys
import time
import numpy as np
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backend/matting'))
import server
from framing import detect_faces, portrait_region, validate_face, PortraitInputError
from matte_cleanup import clean_matte

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('input',type=Path)
p.add_argument('output',type=Path)
a=p.parse_args()
rows=json.loads((a.input/'sources.json').read_text(encoding='utf-8'))['samples']
records=[]
for row in rows:
    image=Image.open(a.input/'dataset'/(row['id']+'-image.png')).convert('RGB')
    faces=detect_faces(image)
    try:
        validate_face(image,faces)
        raw=io.BytesIO();image.save(raw,'PNG');server.matte_image(raw.getvalue())
    except PortraitInputError:
        continue
    focused,region=portrait_region(image,faces)
    truth=Image.open(a.input/'dataset'/(row['id']+'-mask.png')).convert('L')
    if region:
        x,y=round(region['x']*image.width),round(region['y']*image.height)
        truth=truth.crop((x,y,x+focused.width,y+focused.height))
    gt=np.asarray(truth.resize((512,512),Image.Resampling.BILINEAR),dtype=np.float32)/255
    metrics={}
    for short in [512,384,640]:
        w,h=focused.size;scale=min(short/min(w,h),(1024 if short<=512 else 1280)/max(w,h))
        size=(max(32,int(w*scale)//32*32),max(32,int(h*scale)//32*32))
        rgb=(np.asarray(focused.resize(size,Image.Resampling.BOX),dtype=np.float32)-127.5)/127.5
        start=time.perf_counter();alpha=server.session.run(None,{server.session.get_inputs()[0].name:rgb.transpose(2,0,1)[None]})[0].squeeze();ms=(time.perf_counter()-start)*1000
        alpha=clean_matte(alpha,faces[0],region)
        alpha=np.asarray(Image.fromarray(alpha).resize((512,512),Image.Resampling.BILINEAR))
        metrics[str(short)]={'mae':float(abs(alpha-gt).mean()),'background_residual':float(alpha[gt<.01].mean()),'foreground_loss':float((1-alpha[gt>.99]).mean()),'inference_ms':ms}
    records.append({'id':row['id'],'metrics':metrics});print(row['id'],flush=True)
summary={str(s):{k:float(np.mean([r['metrics'][str(s)][k] for r in records])) for k in ['mae','background_residual','foreground_loss','inference_ms']} for s in [512,384,640]}
a.output.write_text(json.dumps({'count':len(records),'summary':summary,'samples':records},indent=2),encoding='utf-8')
print(json.dumps(summary),flush=True)
