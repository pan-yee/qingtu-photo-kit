"""Create a self-contained before/after gallery without changing baseline data."""
import argparse
import base64
import json
from pathlib import Path


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--fixed',type=Path,required=True)
    p.add_argument('--baseline',type=Path,required=True)
    args=p.parse_args()
    report=json.loads((args.fixed/'report.json').read_text(encoding='utf-8'))
    data={**report,'samples':[{**r,'panel':'data:image/jpeg;base64,'+base64.b64encode((args.fixed/r['id']/'comparison.jpg').read_bytes()).decode()}
                             for r in report['samples']]}
    template='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>证件照修复后复测</title>
<style>body{margin:0;background:#f5f5f3;color:#202523;font:16px/1.6 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:28px}h1{font-size:24px}h2{font-size:19px}.lead{border-left:4px solid #286749;padding:12px 18px;background:#edf2ed}.stats{display:flex;gap:32px;flex-wrap:wrap;margin:20px 0}.stats b{font-size:24px;display:block}button{font:inherit;padding:6px 9px;border:1px solid #c8cfc9;border-radius:4px;background:white;color:#202523;cursor:pointer}button.active{background:#286749;color:white}nav{display:flex;gap:6px;flex-wrap:wrap;margin:18px 0}img{width:100%;height:auto;background:white}.muted{color:#56625b;font-size:14px}a{color:#245c42}footer{border-top:1px solid #d1d8d1;margin-top:28px;padding-top:18px}.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}</style>
<main><h1>证件照修复后：同一批 30 张照片复测</h1><div class="muted">2026-11-11 · MODNet 权重不变 · YuNet 233 KB 人脸检测 · CPU 推理 · 不增加收费抠图 API</div>
<p class="lead"><strong>此前 4 张严重错误样本现在明确拒绝生成，衣摆误判多人那张恢复为正确人脸构图。</strong>本批 10 张生成，20 张因无人脸、头部不完整或明显姿态问题被拒绝。这不是 30 张全部生成成功，也不是修复或补画被遮挡的头部。</p>
<div class="stats"><div><b>10</b>生成结果</div><div><b>20</b>明确拒绝不合适素材</div><div><b>4 / 4</b>原严重错误不再输出</div><div><b>170 + 31 + 7</b>前端 / 后端 / worker 测试通过</div></div>
<h2>逐张查看原图、修复前与修复后</h2><div class="bar"><button id="prev">上一张</button><button id="next">下一张</button><span id="position"></span></div><nav id="nav"></nav><p id="meta"></p><img id="panel" alt="原图、修复前和修复后对比"><p id="note"></p><p><a id="source" target="_blank">原始样本来源</a></p>
<h2>修复范围与仍需确认的质量</h2><ul><li>替换会把衣物、头发纹理当人脸的 Haar 检测器；新检测器和 MODNet 均校验固定哈希。</li><li>服务端先检查素材，客户端拒绝旧协议及无人脸结果；不再按猜测的人脸位置生成或静默居中回退。</li><li>检查头部完整性、脸部遮罩和最终人脸是否完整落在裁切区域内；避免短横幅照片底部出现空白色条。</li><li>发丝和浅色衣物仍可能有边缘或背景残留，本批 275 仍需手动修正。五点几何检查不识别所有闭眼或表情，不替代办理机构要求。</li></ul>
<p class="muted">左列为公开原图，中列为旧版离线结果；编号 103 的旧版正式页面实际会误判多人并拒绝。右列若显示 NO IMAGE GENERATED，是明确拦截，不是成功生成。样本包含背影、侧脸、遮挡、源图截头；不能用生成/拒绝数量计算证件照通过率。没有对不同接受样本集合的平均 MAE 做优劣比较。</p>
<p class="muted">ECS 已部署并通过服务器本机接口探测：协议 2、YuNet 单脸、无脸素材返回 422；未经过手机微信登录。外部域名仍返回 403 Non-compliance ICP Filing，手机使用须先解除备案阻断。</p>
<footer><a href="review.html">修复前的 30 张完整验证</a> · <a href="fixed-report.json">修复后 JSON 报告</a><p>来源：<a href="https://github.com/JizhiziLi/P3M">P3M</a> / <a href="https://huggingface.co/datasets/nobg/P3M-10K">下载镜像</a>。引用：Li, Jizhizi, Sihan Ma, Jing Zhang, and Dacheng Tao. Privacy-Preserving Portrait Matting. ACM MM, 2021. 数据集 MIT 发布协议，原照片版权属于原权利人。照片只用于本地离线质量验证。</p></footer></main>
<script>const D=__DATA__;let at=D.samples.findIndex(x=>x.id==='p3m-np-103');const reasons={MATTING_NO_FACE:'未检测到清晰的单人正面人脸，请更换照片',MATTING_INCOMPLETE_HEAD:'头部不完整，请换包含完整头顶和脸部的照片',MATTING_FACE_POSE:'面部姿态不适合，请使用头部端正的正面照片',MATTING_MULTIPLE_FACES:'检测到多个人脸，请选择单人照片',MATTING_INCOMPLETE_SUBJECT:'人像抠图不完整，请更换背景清晰的照片',MATTING_IMAGE_TOO_SMALL:'人脸过小，请选择更清晰的照片',MATTING_INVALID_CROP:'无法完整构图，请更换照片'};function show(){const s=D.samples[at];document.getElementById('nav').innerHTML=D.samples.map((r,i)=>'<button data-i="'+i+'" class="'+(i===at?'active':'')+'">'+String(r.row_index).padStart(3,'0')+(r.status==='rejected'?' 拒绝':' 生成')+'</button>').join('');document.querySelectorAll('[data-i]').forEach(b=>b.onclick=()=>{at=Number(b.dataset.i);show()});document.getElementById('position').textContent=(at+1)+' / 30';document.getElementById('meta').textContent=s.id+' · '+(s.status==='rendered'?'已生成，需人工确认结果与办理要求':'明确拒绝：'+reasons[s.code]);document.getElementById('panel').src=s.panel;document.getElementById('note').textContent='修复前观察：'+s.baseline_notes+(s.status==='rendered'?'；修复后正确定位了主要人脸并完成构图。':'；修复后停止生成，不再输出这张不合适的素材。');document.getElementById('source').href=s.source}document.getElementById('prev').onclick=()=>{at=(at+29)%30;show()};document.getElementById('next').onclick=()=>{at=(at+1)%30;show()};show();</script></html>'''
    args.baseline.joinpath('fixed-review.html').write_text(template.replace('__DATA__',json.dumps(data,ensure_ascii=False).replace('<','\\u003c')),encoding='utf-8')
    args.baseline.joinpath('fixed-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(args.baseline/'fixed-review.html')


if __name__=='__main__':main()
