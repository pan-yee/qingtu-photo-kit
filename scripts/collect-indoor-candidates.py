import urllib.request,urllib.parse,json,concurrent.futures,random,io,sys
from pathlib import Path
from PIL import Image,ImageOps,ImageDraw
out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True);(out/'thumbs').mkdir(exist_ok=True)
def get(u):
 for n in range(3):
  try:return urllib.request.urlopen(u,timeout=45).read()
  except Exception:
   if n==2:raise
rows={}
for offset in range(0,500,100):
 q=urllib.parse.urlencode(dict(dataset='nobg/P3M-10K',config='default',split='P3M_500_NP',offset=offset,length=100));r=json.loads(get('https://datasets-server.huggingface.co/rows?'+q));rows.update({x['row_idx']:x['row'] for x in r['rows']})
(out/'remote-rows.json').write_text(json.dumps(rows));order=list(rows);random.Random(2026111302).shuffle(order);selected=order[:200]
def fetch(i):
 path=out/'thumbs'/f'{i:03d}.jpg'
 if not path.exists():
  im=Image.open(io.BytesIO(get(rows[i]['image']['src']))).convert('RGB');im.thumbnail((240,270));im.save(path,quality=85)
 return i
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
 for n,i in enumerate(pool.map(fetch,selected)):
  if n%20==19:print('downloaded candidate thumbnails',n+1,flush=True)
for start in range(0,len(selected),40):
 panel=Image.new('RGB',(1200,1600),'white');d=ImageDraw.Draw(panel)
 for n,i in enumerate(selected[start:start+40]):
  x=n%6*200;y=n//6*225;im=ImageOps.contain(Image.open(out/'thumbs'/f'{i:03d}.jpg'),(194,195));panel.paste(im,(x+(200-im.width)//2,y+25));d.text((x+5,y+3),f'{i:03d}',fill='black')
 panel.save(out/f'candidates-{start//40}.jpg',quality=90)
(out/'candidate-order.json').write_text(json.dumps(selected));print('candidates ready',flush=True)
