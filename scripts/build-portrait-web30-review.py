"""Build a self-contained local review gallery from the 30-photo evaluation."""
import argparse
import base64
import io
import json
from pathlib import Path
from PIL import Image

REVIEWS = {
  0: ('未见明显主体破损', '头发和花纹衣服基本保留，细发丝略软。原图为转身姿态，不能据此认定符合证件照要求。'),
  17: ('未见明显主体破损', '脸部、短发和黑色衣服完整；蓝白底下未见大块误删。'),
  34: ('输入受限', '背影举手且无人脸；岩石背景有残留，当前仍退回居中输出，不适合直接作为证件照。'),
  52: ('需复核', '可见戴眼镜的人脸但检测为零，退回居中构图；人物抠图总体完整。'),
  69: ('输入受限', '原图发顶已被截断，输出出现明显矩形照片边界及大片补底。不能靠抠图恢复缺失内容。'),
  86: ('未见明显主体破损', '脸部和衣服轮廓基本完整，嘴部姿态并非标准证件照姿态。'),
  103: ('需复核', '单人照片的衣摆区域被误检为第二个人脸，正式页面会错误拒绝生成。已查看人脸框确认位置；离线预览不代表产品放行。'),
  120: ('输入受限', '背影视角，人物和手势基本保留，但没有适合证件照的正面人脸。'),
  138: ('未见明显主体破损', '长发及黑衣主体完整；零散细发丝不完全等同人工标注。'),
  155: ('需复核', '背影非正面素材；衣服左下轮廓与人工标注不同，有偏软及背景残留。'),
  172: ('输入受限', '卷发主体基本保留，但原图上缘已截发，输出上边缘有平直截断，不能当成完整证件照。'),
  189: ('未见明显主体破损', '脸部、长发和深色衣服总体保留，发丝边缘仍有细小差异。'),
  206: ('输入受限', '头发遮挡脸部，无人脸检测；主要发丝和衣服基本保留，但素材不适合正面证件照。'),
  224: ('输入受限', '侧面素材，无人脸对齐；人物轮廓基本保留。'),
  241: ('未见明显主体破损', '白衣没有大块误删；浅色发丝在蓝底可见软边及少量旧背景残色。'),
  258: ('输入受限', '帽子遮挡且为背侧视角；居中裁切截帽，不能生成合适的正面证件照。'),
  275: ('背景/边缘问题', '白衣附近存在块状背景残留，背景泄漏指标超过预设复核阈值；素材另有闭眼和抬手。'),
  293: ('严重主体缺失', '书本遮挡区域及其后的头部被大块抠除，只剩身体和手。原素材本身也不适合证件照。'),
  310: ('严重构图错误', 'Haar 检测框落在下半身区域，自动构图只留下牛仔裤，头部完全被截掉。'),
  327: ('输入受限', '侧后视角且脸部遮挡；发型与衣服基本保留，仍不适合正面证件照。'),
  344: ('严重构图错误', '检测框落在衣服区域，自动构图只留下肩部和上衣，头部被截掉。'),
  361: ('输入受限', '脸部与黑衣抠图较完整，但源照片上缘已截发，结果头顶出现平直边界。'),
  379: ('输入受限', '带帽背影，没有正面人脸；人物抠图主体基本完整。'),
  396: ('严重构图错误', '错误的人脸框落在左上头发区域，自动构图变为头发局部，实际人脸被截掉。'),
  413: ('输入受限', '相机遮挡人脸，检测为零；居中输出仍为全身小人像，不是证件照构图。'),
  430: ('输入受限', '脸部和衣服保留，但原图头顶被截，结果出现明显平直头顶边界。'),
  447: ('输入受限', '原图没有头部；无人脸时仍输出下半身。此类素材应明确拒绝证件照生成。'),
  465: ('输入受限', '背影且头发遮挡；部分细发丝与人工标注有差异，主体衣服仍保留。'),
  482: ('未见明显主体破损', '短发、脸部和外套基本完整，未见明显大块误删。'),
  499: ('输入受限', '头发遮住面部，未检出人脸；头发和衣服主体仍保留，但应提示更换正面照片。')
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    report = json.loads((out / 'evaluation.json').read_text(encoding='utf-8'))
    records = []
    rank = {'严重构图错误': 0, '严重主体缺失': 0, '背景/边缘问题': 1, '需复核': 1, '输入受限': 2, '未见明显主体破损': 3}
    for i, row in enumerate(report['samples']):
        status, notes = REVIEWS[row['row_index']]
        row['manual_status'] = status
        row['manual_notes'] = notes
        folder = out / report['run_folder'] / ('model-0-image-' + str(i))
        panel = Image.open(folder / 'review.jpg')
        encoded = io.BytesIO()
        panel.save(encoded, format='JPEG', quality=85)
        records.append({**row, 'rank': rank[status],
                        'panel': 'data:image/jpeg;base64,' + base64.b64encode(encoded.getvalue()).decode('ascii'),
                        'fullBlue': report['run_folder'] + '/model-0-image-' + str(i) + '/blue-review.jpg'})
    report['manual_review'] = {
        'scope': 'Assistant visual review of all 30 original / blue / white / ground-truth contact panels. Not independent blinded human scoring or ID-photo eligibility certification.',
        'severe_framing_errors': [r['id'] for r in records if r['manual_status'] == '严重构图错误'],
        'severe_subject_loss': [r['id'] for r in records if r['manual_status'] == '严重主体缺失'],
        'confirmed_false_multiple_face_rejections': ['p3m-np-103'],
        'key_caveat': 'Low alpha MAE within a wrong crop does not prove a usable ID photo; ground truth and prediction share the same crop. Numerous inputs are back/side views or occluded and are unsuitable for ID photos.'}
    (out / 'evaluation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    data = {'summary': report['summary'], 'versions': report['runtime_versions'],
            'manual': report['manual_review'], 'samples': records}
    content = json.dumps(data, ensure_ascii=False).replace('<', '\\u003c')
    template = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>30 张公开人像验证</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;background:#f5f5f3;color:#202523}main{max-width:1200px;margin:auto;padding:28px}h1{font-size:24px;margin:0 0 8px}h2{font-size:19px}small,.muted{color:#59635e}.lead{border-left:4px solid #286749;padding:8px 16px;background:#eef3ef}.stats{display:flex;gap:28px;flex-wrap:wrap;margin:22px 0}.stats b{display:block;font-size:22px}button,select{font:inherit;padding:6px 10px;border:1px solid #c6cec8;background:white;border-radius:4px;cursor:pointer}button.active{background:#286749;color:white}nav{display:flex;gap:6px;flex-wrap:wrap;margin:18px 0}img{width:100%;height:auto;background:white}.notes{padding:12px 0;font-size:17px}.layout{display:grid;grid-template-columns:minmax(0,1fr);gap:18px}a{color:#245c42}details{margin-top:24px}table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;padding:7px;border-bottom:1px solid #d9dfda}th{background:#eef0ed}footer{margin-top:28px;border-top:1px solid #c6cec8;padding-top:14px}.hint{font-size:14px}.toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap}</style>
<main><h1>30 张公开人像：当前证件照方案验证</h1><div class="muted">2026-11-11 · P3M-500-NP · 固定等距抽样，不替换失败样本 · MODNet + 当前前端构图与边缘处理</div>
<p class="lead"><strong>结论：不能认定为高质量全自动证件照方案。</strong>逐张查看发现 3 张严重裁错主体，另有 1 张遮挡样本的头部被抠除。多数普通人像的抠图主体完整，但人脸误检、输入筛选和构图校验需要先改进。</p>
<div class="stats" id="stats"></div><div class="hint">MAE 为透明度绝对误差（0 最好），不是准确率。测量范围是最终裁切图，不能发现被裁掉的人脸；耗时仅为本机 CPU 预热推理，不包含手机、网络和安全审核。</div>
<h2>逐张检查原图、蓝底、白底与人工标注</h2><div class="toolbar"><label>排序 <select id="sort"><option value="issue">先看明显问题</option><option value="source">来源编号</option><option value="mae">透明度误差从高到低</option></select></label><button id="prev">上一张</button><button id="next">下一张</button><span id="position"></span></div>
<nav id="nav"></nav><div class="layout"><div id="meta"></div><img id="panel" alt="原图、当前蓝底、当前白底与人工标注白底对比"><div class="notes" id="notes"></div><div id="links"></div></div>
<details><summary>指标定义、抽样方法和限制</summary><p>从 P3M-500-NP 的 500 行中，预先等距选取 30 个行号，保留全部样本。每张图运行原版 MODNet：一次预热、三次计时。用项目中的真实 JavaScript 构图、遮罩和去残色代码生成 900×1200 的评估结果。原图及标注未上传到 ECS 或微信。</p><p>前景误删率：人工 alpha ≥0.95 的像素中，预测 alpha &lt;0.5 的比例。背景泄漏率：人工 alpha ≤0.05 的像素中，预测 alpha &gt;0.5 的比例。边界误差：人工二值轮廓 15×15 形态学边界带上的 alpha MAE。复核阈值分别为 5%、3%、0.20，仅用于找问题，不表示证件照通过率。</p><p>样本包含背影、侧脸、遮挡及源图头顶被截等素材，因此未检出人脸的数量不能当作正面人脸漏检率；30 张不同照片也不等同于 30 位不同人物。没有进行 BiRefNet 或商业 API 的同批对比，不能据此给出模型质量排名。没有经过正式微信内容审核，这些离线图仅作本地测试查看。</p></details>
<details><summary>全部 30 张指标与备注</summary><table><thead><tr><th>编号</th><th>人脸数</th><th>Alpha MAE</th><th>前景误删</th><th>背景泄漏</th><th>人工观察</th></tr></thead><tbody id="rows"></tbody></table></details>
<footer><p>来源：<a href="https://github.com/JizhiziLi/P3M">P3M 原始项目</a> · <a href="https://huggingface.co/datasets/nobg/P3M-10K">下载镜像</a> · <a href="https://jizhizili.github.io/files/p3m_dataset_agreement/P3M-10k_Dataset_Release_Agreement.pdf">数据集 MIT 发布协议</a>。照片版权属于原权利人。</p><p>引用：Li, Jizhizi, Sihan Ma, Jing Zhang, and Dacheng Tao. “Privacy-Preserving Portrait Matting.” ACM Multimedia, 2021.</p><div id="runtime" class="hint"></div><p><a href="evaluation.json">完整 JSON 报告</a> · <a href="sources.json">30 张来源与校验清单</a></p></footer></main>
<script>const D=__DATA__;let selected=D.samples[0].id;const pct=v=>v==null?'—':(v*100).toFixed(1)+'%';const ordered=()=>[...D.samples].sort((a,b)=>document.getElementById('sort').value==='mae'?b.alpha_mae-a.alpha_mae:document.getElementById('sort').value==='source'?a.row_index-b.row_index:a.rank-b.rank||a.row_index-b.row_index);function render(){const list=ordered();const s=D.samples.find(x=>x.id===selected);document.getElementById('nav').innerHTML=list.map(x=>'<button class="'+(x.id===selected?'active':'')+'" data-id="'+x.id+'">'+String(x.row_index).padStart(3,'0')+'</button>').join('');document.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>{selected=b.dataset.id;render()});document.getElementById('position').textContent=(list.findIndex(x=>x.id===selected)+1)+' / 30';document.getElementById('meta').textContent=s.id+' · 检测到 '+s.faces_detected+' 个人脸 · alpha MAE '+s.alpha_mae.toFixed(4)+' · 前景误删 '+pct(s.foreground_loss_fraction)+' · 背景泄漏 '+pct(s.background_leak_fraction);document.getElementById('panel').src=s.panel;document.getElementById('notes').textContent=s.manual_status+'：'+s.manual_notes;document.getElementById('links').innerHTML='<a target="_blank" href="'+s.source+'">样本来源</a> · <a target="_blank" href="'+s.fullBlue+'">完整蓝底评估图</a>';document.getElementById('rows').innerHTML=D.samples.map(x=>'<tr><td>'+x.id+'</td><td>'+x.faces_detected+'</td><td>'+x.alpha_mae.toFixed(4)+'</td><td>'+pct(x.foreground_loss_fraction)+'</td><td>'+pct(x.background_leak_fraction)+'</td><td>'+x.manual_status+'：'+x.manual_notes+'</td></tr>').join('')}document.getElementById('sort').onchange=render;document.getElementById('prev').onclick=()=>{const l=ordered();selected=l[(l.findIndex(x=>x.id===selected)+29)%30].id;render()};document.getElementById('next').onclick=()=>{const l=ordered();selected=l[(l.findIndex(x=>x.id===selected)+1)%30].id;render()};document.getElementById('stats').innerHTML=[['30','不同照片'],['3 + 1','严重构图 / 主体缺失'],[D.summary.mean_alpha_mae.toFixed(4),'平均 alpha MAE'],[Math.round(D.summary.inference_median_ms)+' ms','本机推理中位数']].map(x=>'<div><b>'+x[0]+'</b>'+x[1]+'</div>').join('');document.getElementById('runtime').textContent='依赖：'+JSON.stringify(D.versions)+'；人脸检测：'+D.summary.single_face+' 单脸 / '+D.summary.no_face+' 无脸 / '+D.summary.multiple_faces+' 多脸。';selected=ordered()[0].id;render();</script></html>'''
    (out / 'review.html').write_text(template.replace('__DATA__', content), encoding='utf-8')
    canvas = '''import { useState, useHostTheme, Stack, Row, Grid, H1, H2, Text, Button, Stat } from "cursor/canvas";
const D = __DATA__;
export default function PortraitReview() {
  const t = useHostTheme();
  const rows = [...D.samples].sort((a,b)=>a.rank-b.rank||a.row_index-b.row_index);
  const [index,setIndex] = useState(0);
  const s = rows[index];
  const percent = (v:number|null) => v === null ? '—' : (v*100).toFixed(1)+'%';
  return <Stack gap={18} style={{padding:24,color:t.text.primary,background:t.bg.editor}}>
    <H1>30 张公开人像：证件照质量验证</H1>
    <Text>2026-11-11 · P3M-500-NP 等距抽样 · 全部样本保留 · 当前 MODNet 与前端构图代码</Text>
    <div style={{padding:16,background:t.fill.secondary}}><strong>发现 3 张严重裁错主体，另有 1 张头部被抠除。当前方案不能宣称高质量全自动生成。</strong><p>需要优先处理人脸误检、素材筛选和构图完整性；不是简单增加 GPU 或提高分辨率就能解决。</p></div>
    <Grid columns={4} gap={18}><Stat label="不同照片" value="30"/><Stat label="平均 Alpha MAE，0 最好" value={D.summary.mean_alpha_mae.toFixed(4)}/><Stat label="本机 CPU 预热推理中位数" value={Math.round(D.summary.inference_median_ms)+' ms'}/><Stat label="单脸 / 无脸 / 多脸" value={D.summary.single_face+' / '+D.summary.no_face+' / '+D.summary.multiple_faces}/></Grid>
    <H2>逐张对比：原图 / 蓝底 / 白底 / 人工标注白底</H2>
    <Row gap={8} wrap><Button onClick={()=>setIndex((index+29)%30)}>上一张</Button><Button onClick={()=>setIndex((index+1)%30)}>下一张</Button><Text>{index+1} / 30，按问题优先排序</Text></Row>
    <Row gap={5} wrap>{rows.map((r,i)=><button key={r.id} onClick={()=>setIndex(i)} style={{padding:'5px 8px',cursor:'pointer',border:'1px solid '+t.stroke.primary,background:i===index?t.fill.secondary:t.bg.editor,color:t.text.primary}}>{String(r.row_index).padStart(3,'0')}</button>)}</Row>
    <Text>{s.id} · {s.manual_status} · Alpha MAE {s.alpha_mae.toFixed(4)} · 前景误删 {percent(s.foreground_loss_fraction)} · 背景泄漏 {percent(s.background_leak_fraction)}</Text>
    <img src={s.panel} alt="公开人像与 MODNet 结果及人工标注对比" style={{width:'100%',height:'auto'}}/>
    <Text>{s.manual_notes}</Text><a href={s.source} style={{color:t.text.link}}>查看此样本来源</a>
    <H2>结论适用范围</H2><Text>MAE 比较的是同一最终裁切区域的透明度，不能发现被裁掉的人脸，也不是准确率。无脸样本包含背影、侧脸、遮挡，不能把 14/30 当作正面人脸漏检率。30 张不同照片不保证来自 30 位不同人物。</Text>
    <Text>本次未进行 ECS、手机、微信审核、并发或商业 API 对比。仅本地离线评估，不能用于证明证件照办理资格或模型质量排名。来源与指标说明、完整大图见同目录 review.html 和 evaluation.json。</Text>
    <a href="https://github.com/JizhiziLi/P3M" style={{color:t.text.link}}>P3M 数据集原始项目</a><Text>引用：Li, Jizhizi, Sihan Ma, Jing Zhang, and Dacheng Tao. Privacy-Preserving Portrait Matting. ACM MM, 2021. 数据集 MIT 发布协议；原照片版权属于原权利人。</Text>
  </Stack>
}
'''
    (out / 'portrait-30.canvas.tsx').write_text(canvas.replace('__DATA__', content), encoding='utf-8')
    print(json.dumps({'html': str(out / 'review.html'), 'canvas': str(out / 'portrait-30.canvas.tsx'),
                      'severe_framing': report['manual_review']['severe_framing_errors'],
                      'severe_subject_loss': report['manual_review']['severe_subject_loss']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
