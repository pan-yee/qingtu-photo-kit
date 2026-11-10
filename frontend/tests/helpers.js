/**
 * 构造 RGBA 像素缓冲，painter 返回 [r, g, b] 或 [r, g, b, a]。
 */
function makeImage(width, height, painter) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = painter(x, y)
      const offset = (y * width + x) * 4
      data[offset] = color[0]
      data[offset + 1] = color[1]
      data[offset + 2] = color[2]
      data[offset + 3] = color[3] === undefined ? 255 : color[3]
    }
  }
  return { data: data, width: width, height: height }
}

function pixelAt(image, x, y) {
  const offset = (y * image.width + x) * 4
  return [
    image.data[offset],
    image.data[offset + 1],
    image.data[offset + 2],
    image.data[offset + 3]
  ]
}

module.exports = {
  makeImage,
  pixelAt
}
