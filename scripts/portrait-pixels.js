// 用于 Python 效果验证：复用小程序实际使用的输入与遮罩后处理代码。
const fs = require('fs')
const portrait = require('../miniprogram/utils/portrait-segmentation')
const legacy = require('../miniprogram/utils/image-processing')
const [mode, imagePath, w, h, target, maskPath] = process.argv.slice(2)
const image = { width: Number(w), height: Number(h), data: new Uint8ClampedArray(fs.readFileSync(imagePath)) }
if (image.data.length !== image.width * image.height * 4) throw new Error('RGBA length mismatch')
if (mode === 'input') {
  fs.writeFileSync(target, Buffer.from(portrait.createInput(image).buffer))
} else if (mode === 'render') {
  const bytes = fs.readFileSync(maskPath)
  const mask = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const result = portrait.applyPortraitMask(image, mask, { tolerance: 36, featherRadius: 3 })
  fs.writeFileSync(target + '.model.rgba', Buffer.from(result.data))
  const before = legacy.removeBackground(image, { tolerance: 36, feather: true, featherRadius: 3 })
  fs.writeFileSync(target + '.legacy.rgba', Buffer.from(before.data))
} else {
  throw new Error('Expected input or render mode')
}
