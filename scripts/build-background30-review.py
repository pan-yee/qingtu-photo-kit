"""Build a local visual QA gallery for the paired real-render regression."""
import argparse
import base64
import io
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input', type=Path, required=True)
    args = p.parse_args()
    root = args.input
    report = json.loads((root / 'comparison.json').read_text())
    notes_path = Path(__file__).resolve().parents[1] / 'docs/validation/background30-manual-review.json'
    notes = json.loads(notes_path.read_text(encoding='utf-8'))['samples'] if notes_path.exists() else {}
    gallery = []
    for row in report['samples']:
        entry = {'id': row['id'], 'source': row['source'], 'metrics': row['metrics'], 'images': {}}
        entry['manual'] = notes.get(row['id'][-3:], {})
        image = Image.open(root / 'dataset' / (row['id'] + '-image.png')).convert('RGB')
        image.thumbnail((500, 650))
        b = io.BytesIO(); image.save(b, 'JPEG', quality=85)
        entry['original'] = 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode()
        for version in ['before', 'after']:
            for tolerance in [12, 36, 82]:
                for background in ['blue', 'white']:
                    key = f'{version}-{tolerance}-{background}'
                    file = root / row['id'] / (key + '.jpg')
                    if file.exists():
                        entry['images'][key] = 'data:image/jpeg;base64,' + base64.b64encode(file.read_bytes()).decode()
        gallery.append(entry)
    template = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>30张人像背景清理前后对比</title>
<style>body{font:15px/1.6 system-ui,sans-serif;color:#202723;background:#f6f6f3;margin:0}main{max-width:1250px;padding:24px;margin:auto}h1{font-size:24px}h2{font-size:18px}button,select{font:inherit;padding:7px 11px;border:1px solid #b8c2bb;background:white;border-radius:5px;color:inherit}button{cursor:pointer}nav{display:flex;flex-wrap:wrap;gap:5px;margin:15px 0}.active{background:#245940;color:white}.controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.photos{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}figure{margin:0}img{width:100%;height:520px;object-fit:contain;background:#e9ebe7}.note{border-left:4px solid #245940;padding:10px 18px;background:#e9f1e9}.muted{color:#58655d}a{color:#245940}@media(max-width:650px){.photos{gap:5px}img{height:300px}main{padding:12px}}</style>
<main><h1>不同背景人像：30张真实生成前后对比</h1><p class="muted">2026-11-13 · 同一 MODNet 权重 · 同一图片配对比较 · 蓝底 / 白底 · 本机离线回归</p>
<p class="note">修复“保留更多”时背景复活、“清除更彻底”时衣服变透的范围调节问题；增加人脸连接主体之外的背景碎块清理。<strong>默认档的改进较小；范围调节的修复较明显。</strong>细发丝、同色背景和与主体连接的背景块仍可能需要手动修正。</p>
<p>30张均通过现有输入规则并在修复前后实际生成。筛选只按单人正面、完整头部和脸部遮罩规则，原始初筛与拒绝记录另存；没有因为背景分数差而替换照片。这批用于诊断与开发，不是独立泛化测试或机构受理认证。</p>
<div class="controls"><button id="prev">上一张</button><button id="next">下一张</button><span id="count"></span><label>边缘范围 <select id="range"><option value="36">36 默认</option><option value="12">12 保留更多</option><option value="82">82 清除更多</option></select></label><label>背景 <select id="bg"><option value="blue">蓝色</option><option value="white">白色</option></select></label></div><nav id="nav"></nav>
<div class="photos"><figure><figcaption>公开原图</figcaption><img id="original" alt="原图"></figure><figure><figcaption>优化前 · 同档位</figcaption><img id="before" alt="优化前"></figure><figure><figcaption>优化后 · 同档位</figcaption><img id="after" alt="优化后"></figure></div><p id="metric"></p><p id="manual" class="note"></p><p><a id="source" target="_blank">查看该照片来源</a> · <a href="comparison.json">完整配对指标</a> · <a href="sources.json">选样、来源和哈希</a></p>
<h2>指标如何理解</h2><p>下方数值在相同模型区域中与人工标注比较，不把不同构图相互比较。背景平均不透明度越低越干净；主体不透明度损失越低越能保留衣服和皮肤。0%不等于视觉完美，人工标注也不能提供完整的发丝前景原色。</p><p id="summary"></p><p class="muted">照片来自 <a href="https://github.com/JizhiziLi/P3M">P3M 项目</a> / <a href="https://huggingface.co/datasets/nobg/P3M-10K">下载镜像</a>，原图版权属于权利人，只用于离线软件质量验证；没有上传照片到云审核、调用付费 API 或测试手机/ECS 延迟。代码尚需部署 ECS，并重新编译小程序才能在线生效。</p></main>
<script>const D=__DATA__,S=__SUMMARY__;let at=0;const el=id=>document.getElementById(id),pct=x=>(x*100).toFixed(3)+'%';function show(){let r=D[at],t=el('range').value,b=el('bg').value;el('count').textContent=(at+1)+' / '+D.length+' · '+r.id;el('original').src=r.original;for(const v of ['before','after'])el(v).src=r.images[v+'-'+t+'-'+b];el('source').href=r.source;el('manual').textContent=(r.manual.background||'')+'：'+(r.manual.note||'');const m=r.metrics[t];el('metric').textContent='本图背景平均不透明度：'+pct(m.before.background_opacity)+' → '+pct(m.after.background_opacity)+'；主体不透明度损失：'+pct(m.before.foreground_opacity_loss)+' → '+pct(m.after.foreground_opacity_loss);el('nav').innerHTML=D.map((x,i)=>'<button data-i="'+i+'" class="'+(i===at?'active':'')+'">'+x.id.slice(-3)+'</button>').join('');document.querySelectorAll('[data-i]').forEach(b=>b.onclick=()=>{at=Number(b.dataset.i);show()});const a=S[t];el('summary').textContent='当前档位30张平均：背景不透明度 '+pct(a.before.background_opacity)+' → '+pct(a.after.background_opacity)+'；主体损失 '+pct(a.before.foreground_opacity_loss)+' → '+pct(a.after.foreground_opacity_loss)+'。';}el('prev').onclick=()=>{at=(at+D.length-1)%D.length;show()};el('next').onclick=()=>{at=(at+1)%D.length;show()};el('range').onchange=show;el('bg').onchange=show;show();</script></html>'''
    (root / 'review.html').write_text(template.replace('__DATA__', json.dumps(gallery).replace('<', '\\u003c')).replace('__SUMMARY__', json.dumps(report['summary'])), encoding='utf-8')
    # Compact contact sheets for visual inspection; not used to compute metrics.
    for start in range(0, len(report['samples']), 5):
        panel = Image.new('RGB', (1000, 1850), 'white')
        draw = ImageDraw.Draw(panel)
        for n, row in enumerate(report['samples'][start:start + 5]):
            draw.text((4, n * 370 + 3), row['id'] + ' ORIGINAL / BEFORE DEFAULT / AFTER DEFAULT / AFTER WHITE', fill='black')
            files = [root / 'dataset' / (row['id'] + '-image.png'), root / row['id'] / 'before-36-blue.jpg', root / row['id'] / 'after-36-blue.jpg', root / row['id'] / 'after-36-white.jpg']
            for col, file in enumerate(files):
                if file.exists():
                    photo = ImageOps.contain(Image.open(file).convert('RGB'), (245, 340))
                    panel.paste(photo, (col * 250 + (250 - photo.width) // 2, n * 370 + 25))
        panel.save(root / f'contact-{start // 5 + 1}.jpg', quality=90)
    print(root / 'review.html')


if __name__ == '__main__':
    main()
