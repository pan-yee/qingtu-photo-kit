"""Build a 100-photo paired gallery, including rejected photos rather than hiding failures."""
import argparse,json,base64,io,sys
from pathlib import Path
from PIL import Image,ImageOps,ImageDraw
p=argparse.ArgumentParser(description=__doc__);p.add_argument('root',type=Path);p.add_argument('--title');p.add_argument('--selection');p.add_argument('--change-note');args=p.parse_args()
root=args.root;before=json.loads((root/'before/report.json').read_text(encoding='utf-8'));after=json.loads((root/'after/report.json').read_text(encoding='utf-8'));old={x['id']:x for x in before['samples']};rows=[]
manifest=json.loads((root/'sources.json').read_text(encoding='utf-8'));scenes={r['id']:r.get('scene','') for r in manifest['samples']}
for r in after['samples']:
 b=old[r['id']];entry={'id':r['id'],'source':r['source'],'before':b,'after':r,'images':{},'scene':scenes.get(r['id'],'')}
 for name,file in [('original',root/'dataset'/(r['id']+'-image.png')),('before',root/'before'/r['id']/'blue.jpg'),('after',root/'after'/r['id']/'blue.jpg'),('white',root/'after'/r['id']/'white.jpg')]:
  if file.exists() and (name == 'original' or (b if name == 'before' else r)['status'] == 'rendered'):
   image=Image.open(file).convert('RGB');image.thumbnail((450,600));buf=io.BytesIO();image.save(buf,'JPEG',quality=85);entry['images'][name]='data:image/jpeg;base64,'+base64.b64encode(buf.getvalue()).decode()
 rows.append(entry)
changed=[r['id'] for r in rows if r['before']['status']!=r['after']['status'] or r['before'].get('crop')!=r['after'].get('crop')]
report={'count':len(rows),'selection':manifest.get('selection','specified regression case'),'before':before['summary'],'after':after['summary'],'changed':changed,'after_reasons':after['reasons'],'scope':'All inputs retained, selection documented in sources.json. Actual worker and frontend render, offline only; rejection is not successful generation or ID compliance.','samples':[{'id':r['id'],'before':r['before'],'after':r['after']} for r in rows]};(root/'report.json').write_text(json.dumps(report,indent=2))
html='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>随机100张照片证件照验证</title><style>body{font:16px/1.6 system-ui;background:#f6f6f3;color:#202723;margin:0}main{max-width:1200px;margin:auto;padding:24px}h1{font-size:25px}nav{display:flex;flex-wrap:wrap;gap:5px;margin:16px 0}button{font:inherit;padding:5px 9px;background:white;border:1px solid #aab8ae;border-radius:4px;cursor:pointer}.active{background:#245c40;color:white}.photos{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}img{width:100%;height:460px;object-fit:contain}figure{margin:0}.note{padding:15px;background:#e8efe8}a{color:#245c40}</style><main><h1>互联网随机100张照片：证件照前后验证</h1><p>2026-11-13 · 固定随机种子20261113 · 从公开P3M-500-NP随机抽取100张，不按生成结果换样本</p><p class="note" id="summary"></p><p>修复局部推理区域截掉发顶却未检查的问题：发现局部顶边被人物占据时，用完整原图重试一次；仍然截头则拒绝。背景、发丝和姿态仍有局限，不等于100张成功或正式证件照合格。本页未验证手机或线上部署。</p><button id="prev">上一张</button><button id="next">下一张</button><span id="count"></span><nav id="nav"></nav><p id="status"></p><div class="photos"><figure>原图<img id="original"></figure><figure>优化前蓝底<img id="before"></figure><figure>优化后蓝底<img id="after"></figure><figure>优化后白底<img id="white"></figure></div><p><a id="source" target="_blank">照片来源</a> · <a href="report.json">完整100张结果</a> · <a href="sources.json">来源与下载字节哈希</a></p><p>拒绝意味着没有生成图片，不是成功。随机样本中可能包括背影、遮挡、多人和截头。抠图模型没有更换，没有调用付费API或向微信/ECS上传这些测试图片。</p></main><script>const D=__DATA__,R=__REPORT__;let at=0;const el=id=>document.getElementById(id);el('summary').textContent='优化前：'+JSON.stringify(R.before)+'；优化后：'+JSON.stringify(R.after)+'；结果或构图发生变化：'+R.changed.join(', ');function show(){let r=D[at];el('count').textContent=(at+1)+' / '+D.length+' '+r.id;el('status').textContent=(r.scene?'场景：'+r.scene+'；':'')+'前：'+r.before.status+' '+(r.before.code||'')+'；后：'+r.after.status+' '+(r.after.code||'');for(let k of ['original','before','after','white']){el(k).src=r.images[k]||'';el(k).style.visibility=r.images[k]?'visible':'hidden'}el('source').href=r.source;el('nav').innerHTML=D.map((s,i)=>'<button class="'+(i===at?'active':'')+'" data-i="'+i+'">'+s.id.slice(-3)+(s.after.status==='rejected'?' ×':'')+'</button>').join('');document.querySelectorAll('[data-i]').forEach(b=>b.onclick=()=>{at=+b.dataset.i;show()})}el('prev').onclick=()=>{at=(at+D.length-1)%D.length;show()};el('next').onclick=()=>{at=(at+1)%D.length;show()};show();</script></html>''';
if args.title:
 import html as html_escape
 html=html.replace('随机100张照片证件照验证',html_escape.escape(args.title)).replace('互联网随机100张照片：证件照前后验证',html_escape.escape(args.title))
 html=html.replace('固定随机种子20261113 · 从公开P3M-500-NP随机抽取100张，不按生成结果换样本',html_escape.escape(args.selection or manifest.get('selection','')))
 html=html.replace('修复局部推理区域截掉发顶却未检查的问题：发现局部顶边被人物占据时，用完整原图重试一次；仍然截头则拒绝。',html_escape.escape(args.change_note or ''))
 html=html.replace('完整100张结果',f'完整{len(rows)}张结果')
elif any(scenes.values()):
 html=html.replace('随机100张照片证件照验证','室内照片证件照验证').replace('互联网随机100张照片：证件照前后验证','室内与影棚30张：证件照验证').replace('固定随机种子20261113 · 从公开P3M-500-NP随机抽取100张，不按生成结果换样本','先核对室内与影棚场景，再固定随机抽取30张；不按生成结果换样本').replace('修复局部推理区域截掉发顶却未检查的问题：发现局部顶边被人物占据时，用完整原图重试一次；仍然截头则拒绝。','本轮生成算法保持607faaf；中间大图画布释放优化不改变输出像素。明暗校正候选测试效果更差，未加入产品。').replace('100张成功','全部成功').replace('随机100张','这批照片')
(root/'review.html').write_text(html.replace('__DATA__',json.dumps(rows).replace('<','\\u003c')).replace('__REPORT__',json.dumps({k:v for k,v in report.items() if k!='samples'})),encoding='utf-8')
for i,r in enumerate([r for r in rows if r['id'] in changed]):
 panel=Image.new('RGB',(1000,390),'white');draw=ImageDraw.Draw(panel);draw.text((5,4),r['id']+' ORIGINAL / BEFORE / AFTER / WHITE',fill='black')
 for col,key in enumerate(['original','before','after','white']):
  if key in r['images']:
   photo=ImageOps.contain(Image.open(io.BytesIO(base64.b64decode(r['images'][key].split(',')[1]))),(240,350));panel.paste(photo,(250*col,30))
 panel.save(root/('changed-'+r['id']+'.jpg'),quality=90)
print(json.dumps({k:v for k,v in report.items() if k!='samples'},indent=2))
