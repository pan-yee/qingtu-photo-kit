// Test bridge: execute the same framing and alpha/color processing as the app.
const fs = require('fs')
const framing = require('../miniprogram/utils/portrait-framing')
const portrait = require('../miniprogram/utils/portrait-segmentation')
const [mode, metadataPath] = process.argv.slice(2)
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
const bytes = fs.readFileSync(metadata.maskPath)
const mask = { matting: true, width: metadata.maskWidth, height: metadata.maskHeight,
  region: metadata.region || null,
  data: new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) }
if (mode === 'frame') {
  const crop = framing.portraitCrop(metadata.width, metadata.height, metadata.face, mask, 900, 1200)
  const cropped = framing.cropMask(mask, crop, metadata.width, metadata.height)
  fs.writeFileSync(metadata.output + '.f32', Buffer.from(cropped.data.buffer))
  fs.writeFileSync(metadata.output + '.json', JSON.stringify({ crop, width: cropped.width, height: cropped.height }))
} else if (mode === 'render') {
  const image = { width: 900, height: 1200, data: new Uint8ClampedArray(fs.readFileSync(metadata.imagePath)) }
  const output = portrait.applyPortraitMask(image, mask, { edgeCleanup: true })
  fs.writeFileSync(metadata.output, Buffer.from(output.data))
} else throw new Error('Expected frame or render')
