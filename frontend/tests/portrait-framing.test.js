const { assert, test } = require('./harness')
const framing = require('../miniprogram/utils/portrait-framing')

test('完整照片仅等比缩小，宽幅照片不提前裁掉主体', function () {
  assert.deepStrictEqual(framing.fitSize(3200, 1800, 1600), { width: 1600, height: 900 })
  assert.deepStrictEqual(framing.fitSize(300, 500, 1600), { width: 300, height: 500 })
})

test('偏左人脸会对齐到照片中央，头顶留白且包含发顶', function () {
  const mask = { matting: true, width: 100, height: 100, data: new Float32Array(10000) }
  for (let y = 10; y < 100; y += 1) {
    for (let x = 5; x < 40; x += 1) mask.data[y * 100 + x] = 1
  }
  const face = { x: .1, y: .2, width: .2, height: .2 }
  const crop = framing.portraitCrop(1000, 1000, face, mask, 900, 1200)
  assert.strictEqual(crop.faceAligned, true)
  assert(Math.abs(crop.sx + crop.sw / 2 - 200) < 1e-6)
  const headTop = (100 - crop.sy) / crop.sh
  assert(headTop > .05 && headTop < .13)
  assert(Math.abs(crop.sw / crop.sh - .75) < 1e-6)
})

test('构图允许图外透明留白，遮罩同步裁切且不复制边缘人物', function () {
  const mask = { matting: true, width: 2, height: 2, data: new Float32Array(4).fill(1) }
  const result = framing.cropMask(mask, { sx: -50, sy: 0, sw: 100, sh: 100 }, 100, 100)
  assert.strictEqual(result.data[0], 0)
  assert.strictEqual(result.data[449], 1)
  assert.strictEqual(result.matting, true)
})

test('没有人脸或异常坐标时不猜测人脸位置，返回可识别的居中构图', function () {
  assert.strictEqual(framing.validFace({ x: NaN, y: 0, width: .2, height: .2 }), false)
  assert.strictEqual(framing.validFace({ x: .9, y: 0, width: .2, height: .2 }), false)
  const crop = framing.portraitCrop(1000, 500, null, null, 900, 1200)
  assert.strictEqual(crop.faceAligned, false)
  assert.strictEqual(crop.sy, 0)
  assert.strictEqual(crop.sh, 500)
})

test('局部推理的遮罩按原图坐标还原，不把局部人像拉满整张照片', function () {
  const mask = { matting: true, width: 4, height: 4, data: new Float32Array(16).fill(1),
    region: { x: .25, y: .25, width: .5, height: .5 } }
  const result = framing.cropMask(mask, { sx: 0, sy: 0, sw: 100, sh: 100 }, 100, 100)
  assert.strictEqual(result.data[0], 0)
  assert.strictEqual(result.data[300 * 450 + 225], 1)
  assert.strictEqual(result.data[599 * 450 + 449], 0)
})

test('最终构图必须包含完整人脸，不接受无脸回退、裁掉脸部或过大补边', function () {
  const face = { x: .3, y: .2, width: .3, height: .3 }
  const good = { sx: 100, sy: 50, sw: 600, sh: 800, faceAligned: true }
  assert.strictEqual(framing.validPortraitCrop(1000,1000,face,good), true)
  assert.strictEqual(framing.validPortraitCrop(1000,1000,null,good), false)
  assert.strictEqual(framing.validPortraitCrop(1000,1000,face,{ ...good, sy: 400 }), false)
  assert.strictEqual(framing.validPortraitCrop(1000,1000,face,{ ...good, sh: 1600 }), false)
  assert.strictEqual(framing.validPortraitCrop(1000,1000,face,{ ...good, faceAligned: false }), false)
})

test('短横幅人像的最终裁切下沿不越过原图，不生成身体下方的空白底色条', function () {
  const face = { x: .4, y: .1, width: .2, height: .5 }
  const mask = { matting: true, width: 100, height: 100, data: new Float32Array(10000) }
  for (let y=4;y<100;y+=1) for(let x=30;x<70;x+=1) mask.data[y*100+x]=1
  const crop=framing.portraitCrop(1600,700,face,mask,900,1200)
  assert(crop.sy+crop.sh<=700+1e-6)
  assert.strictEqual(framing.validPortraitCrop(1600,700,face,crop),true)
})

test('高清裁切直接采样到输出网格，保留单像素发丝而不经过半分辨率遮罩', function () {
  const width = 900, height = 1200
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++) data[y * width + 451] = .75
  const mask = { matting: true, width, height, data }
  const result = framing.cropMask(mask, { sx: 0, sy: 0, sw: width, sh: height }, width, height, width, height)
  assert.strictEqual(result.width, width)
  assert.strictEqual(result.height, height)
  for (const y of [0, 600, 1199]) {
    assert(Math.abs(result.data[y * width + 451] - .75) < 1e-6)
    assert(result.data[y * width + 450] < 1e-6)
    assert(result.data[y * width + 452] < 1e-6)
  }
  assert.throws(() => framing.cropMask(mask, {}, width, height, 100000, height), /尺寸/)
})
