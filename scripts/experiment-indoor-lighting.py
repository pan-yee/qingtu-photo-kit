import sys,json,base64,io,time
from pathlib import Path
import numpy as np
from PIL import Image
sys.path.insert(0,str(Path.cwd()/'backend/matting'));import server
from framing import PortraitInputError
root=Path(sys.argv[1]);rows=json.loads((root/'sources.json').read_text(encoding='utf-8'))['samples'];original=server.infer_matte;reports=[]
for row in rows:
 image=Image.open(root/'dataset'/(row['id']+'-image.png')).convert('RGB');raw=io.BytesIO();image.save(raw,'PNG');metrics={}
 for gamma in [1,.8,1.2]:
  def infer(im,g=gamma):
   if g!=1:im=im.point([round((i/255)**g*255) for i in range(256)]*3)
   return original(im)
  server.infer_matte=infer
  try:
   result=server.matte_image(raw.getvalue());a=np.array(Image.open(io.BytesIO(base64.b64decode(result['png']))),dtype=np.float32)/255;gt=Image.open(root/'dataset'/(row['id']+'-mask.png')).convert('L');r=result['region']
   if r:
    left=round(r['x']*image.width);top=round(r['y']*image.height);gt=gt.crop((left,top,left+round(r['width']*image.width),top+round(r['height']*image.height)))
   gt=np.array(gt.resize((result['width'],result['height']),Image.Resampling.BILINEAR),dtype=np.float32)/255;metrics[str(gamma)]={'mae':float(abs(a-gt).mean()),'bg':float(a[gt<.01].mean()),'fg':float((1-a[gt>.99]).mean())}
  except PortraitInputError as e:metrics[str(gamma)]={'code':e.code}
 reports.append({'id':row['id'],'metrics':metrics})
paired=[r for r in reports if all('mae' in m for m in r['metrics'].values())]
for g in ['1','0.8','1.2']:print(g,len(paired),{k:float(np.mean([r['metrics'][g][k] for r in paired])) for k in ['mae','bg','fg']})
(root/'lighting-experiment.json').write_text(json.dumps(reports,indent=2));server.infer_matte=original
