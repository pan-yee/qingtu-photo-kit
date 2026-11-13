import json,random,urllib.request,io,hashlib,concurrent.futures,sys
from pathlib import Path
from PIL import Image
out=Path(sys.argv[1]);remote=json.loads((out/'remote-rows.json').read_text());pool={254:'窗边建筑内部',153:'木墙及沙发',171:'室内墙面',196:'窗边逆光',166:'沙发',128:'室内墙面阴影',243:'白墙护墙板',54:'室内走廊',253:'暖色墙面',162:'窗框逆光',109:'沙发椅背',339:'布景家具',197:'粉色墙面',40:'室内窗边',224:'房间地毯',341:'浅色墙面',199:'黑色影棚',182:'室内家具',11:'楼梯及白砖墙',208:'书架室内',156:'展厅杂物',457:'白窗帘逆光',248:'房间走廊',276:'室内窗门逆光',376:'暖色房间',184:'室内门框',51:'浅色影棚',394:'墙面阴影',98:'灰色影棚',39:'粉色影棚',136:'深色影棚',222:'暗光影棚',318:'灰色影棚',203:'黄色影棚',195:'浅色影棚',311:'粉色墙面影棚',406:'深色影棚'}
ids=random.Random(2026111303).sample(list(pool),30);(out/'dataset').mkdir(exist_ok=True)
def fetch(i):
 row=remote[str(i)];record={'id':f'p3m-np-{i:03d}','row_index':i,'scene':pool[i],'scene_basis':'人工根据公开照片中的窗户、家具、内墙或摄影背景判断；棚拍与实景分开标注，非拍摄地点认证','source':f'https://huggingface.co/datasets/nobg/P3M-10K/viewer/default/P3M_500_NP?row={i}'}
 for field in ['image','mask']:
  b=urllib.request.urlopen(row[field]['src'],timeout=60).read();im=Image.open(io.BytesIO(b));im.thumbnail((1600,1600));im.convert('RGB' if field=='image' else 'L').save(out/'dataset'/(record['id']+'-'+field+'.png'));record[field+'_sha256']=hashlib.sha256(b).hexdigest()
 print('downloaded',record['id'],pool[i],flush=True);return record
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as p:rows=list(p.map(fetch,ids))
assert len(rows)==30 and len({r['image_sha256'] for r in rows})==30
(out/'sources.json').write_text(json.dumps({'dataset':'P3M_500_NP','selection':'先人工筛选37张室内或棚拍候选，再使用随机种子2026111303抽取30张；不按生成结果换样本','candidate_scenes':pool,'samples':rows},ensure_ascii=False,indent=2),encoding='utf-8')
