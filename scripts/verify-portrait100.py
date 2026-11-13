"""Run a pinned worker over every random sample, retaining rejections and real renders."""
import argparse,base64,io,json,sys,subprocess,time
from pathlib import Path
from collections import Counter
import numpy as np
from PIL import Image,ImageOps
ROOT=Path(__file__).resolve().parents[1]
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--input',type=Path,required=True);p.add_argument('--worker',type=Path,required=True);p.add_argument('--name',required=True);p.add_argument('--node',default='node');a=p.parse_args()
 sys.path.insert(0,str(a.worker.resolve()));import server
 from framing import PortraitInputError
 rows=json.loads((a.input/'sources.json').read_text(encoding='utf-8'))['samples'];out=a.input/a.name;out.mkdir(exist_ok=True);records=[]
 for row in rows:
  dest=out/row['id'];dest.mkdir(exist_ok=True);record={'id':row['id'],'source':row['source']};start=time.perf_counter()
  try:
   image=Image.open(a.input/'dataset'/(row['id']+'-image.png')).convert('RGB');b=io.BytesIO();image.save(b,'PNG');r=server.matte_image(b.getvalue())
   mask=np.asarray(Image.open(io.BytesIO(base64.b64decode(r['png']))),dtype=np.float32)/255;mask.tofile(dest/'mask.f32')
   request={'width':image.width,'height':image.height,'face':r['faces'][0],'region':r['region'],'maskPath':str(dest/'mask.f32'),'maskWidth':r['width'],'maskHeight':r['height'],'output':str(dest/'frame')}
   (dest/'frame-request.json').write_text(json.dumps(request));subprocess.run([a.node,str(ROOT/'frontend/scripts/matting-pixels.js'),'frame',str(dest/'frame-request.json')],check=True)
   frame=json.loads((dest/'frame.json').read_text(encoding='utf-8'));crop=frame['crop']
   if not frame['validCrop']:raise PortraitInputError('MATTING_INVALID_CROP')
   source=image.convert('RGBA').transform((900,1200),Image.Transform.AFFINE,(crop['sw']/900,0,crop['sx'],0,crop['sh']/1200,crop['sy']),Image.Resampling.BILINEAR);(dest/'source.rgba').write_bytes(source.tobytes())
   request={'maskPath':str(dest/'frame.f32'),'maskWidth':frame['width'],'maskHeight':frame['height'],'imagePath':str(dest/'source.rgba'),'output':str(dest/'result.rgba')}
   (dest/'render-request.json').write_text(json.dumps(request));subprocess.run([a.node,str(ROOT/'frontend/scripts/matting-pixels.js'),'render',str(dest/'render-request.json')],check=True)
   rgba=Image.frombytes('RGBA',(900,1200),(dest/'result.rgba').read_bytes())
   for name,color in [('blue','#438edb'),('white','#ffffff')]:
    bg=Image.new('RGBA',rgba.size,color);bg.alpha_composite(rgba);bg.convert('RGB').save(dest/(name+'.jpg'),quality=90)
   record.update(status='rendered',region=r['region'],crop=crop)
  except PortraitInputError as e:
   record.update(status='rejected',code=e.code)
   for f in [dest/'blue.jpg',dest/'white.jpg']:f.unlink(missing_ok=True)
  finally:
   for f in list(dest.glob('*.f32'))+list(dest.glob('*.rgba')):f.unlink()
  record['elapsed_ms']=round((time.perf_counter()-start)*1000,2);records.append(record);print(a.name,row['id'],record['status'],record.get('code',''),flush=True)
 report={'samples':records,'summary':dict(Counter(x['status'] for x in records)),'reasons':dict(Counter(x['code'] for x in records if x['status']=='rejected'))};(out/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report['summary']))
if __name__=='__main__':main()
