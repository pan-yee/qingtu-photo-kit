// 可选的官方实现对照：需通过 NODE_PATH 提供 playwright。
// 参数：解包的官方 npm 资源目录、256×256 输入 PNG、输出灰度遮罩 PNG。
const fs = require('fs')
const path = require('path')
const http = require('http')
const { chromium } = require('playwright')
const [assets, input, output] = process.argv.slice(2)
if (!assets || !input || !output) throw new Error('Expected assets directory, input PNG and output PNG')
const html = `<!doctype html><script src="selfie_segmentation.js"></script><script>
window.result = (async function () {
  const image = new Image(); image.src = 'input.png'; await image.decode();
  if (image.width !== 256 || image.height !== 256) throw new Error('Expected 256x256 PNG');
  const segmenter = new SelfieSegmentation({ locateFile: file => file });
  segmenter.setOptions({ modelSelection: 0, selfieMode: false });
  const done = new Promise(resolve => segmenter.onResults(result => {
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
    const context = canvas.getContext('2d'); context.drawImage(result.segmentationMask, 0, 0);
    const rgba = context.getImageData(0, 0, 256, 256);
    for (let i = 0; i < rgba.data.length; i += 4) {
      rgba.data[i] = rgba.data[i + 1] = rgba.data[i + 2] = rgba.data[i + 3];
      rgba.data[i + 3] = 255;
    }
    context.putImageData(rgba, 0, 0); resolve(canvas.toDataURL('image/png'));
  }));
  await segmenter.send({ image }); return await done;
})();</script>`
const server = http.createServer((request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname.slice(1)
  if (!name) { response.end(html); return }
  if (name !== path.basename(name) || !/\.(?:js|wasm|data|binarypb|tflite|png)$/.test(name)) {
    response.writeHead(404).end(); return
  }
  const file = name === 'input.png' ? input : path.join(assets, name)
  if (!fs.existsSync(file)) { response.writeHead(404).end(); return }
  const types = { '.wasm': 'application/wasm', '.js': 'text/javascript', '.png': 'image/png' }
  response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream')
  fs.createReadStream(file).pipe(response)
})
;(async function () {
  let browser
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true, args: ['--no-sandbox'] })
    const page = await browser.newPage()
    await page.goto('http://127.0.0.1:' + server.address().port)
    const result = await page.evaluate(() => window.result)
    fs.writeFileSync(output, Buffer.from(result.split(',')[1], 'base64'))
    console.log('Official MediaPipe reference mask saved: ' + output)
  } finally {
    if (browser) await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
