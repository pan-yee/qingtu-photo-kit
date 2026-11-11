// Geometry only: preserves image bytes and does not replace content checks.
function fitInside(width, height, maxSide) {
  if (![width, height, maxSide].every(value => Number.isFinite(value) && value > 0)) throw new Error('图片尺寸无效')
  const scale = Math.min(1, maxSide / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

function placement(width, height, targetWidth, targetHeight, mode, position) {
  if (![width, height, targetWidth, targetHeight].every(value => Number.isFinite(value) && value > 0)) throw new Error('图片尺寸无效')
  if (mode === 'contain') {
    const scale = Math.min(targetWidth / width, targetHeight / height)
    const dw = width * scale,
      dh = height * scale
    return { sx: 0, sy: 0, sw: width, sh: height, dx: (targetWidth - dw) / 2, dy: (targetHeight - dh) / 2, dw, dh }
  }
  const scale = Math.max(targetWidth / width, targetHeight / height)
  const sw = targetWidth / scale,
    sh = targetHeight / scale
  const offset = Math.max(0, Math.min(1, Number.isFinite(position) ? position : .5))
  return { sx: (width - sw) * offset, sy: (height - sh) * offset, sw, sh, dx: 0, dy: 0, dw: targetWidth, dh: targetHeight }
}

function draw(context, image, x, y, width, height, mode, position) {
  const p = placement(image.width || image.naturalWidth, image.height || image.naturalHeight, width, height, mode, position)
  context.drawImage(image, p.sx, p.sy, p.sw, p.sh, x + p.dx, y + p.dy, p.dw, p.dh)
}

module.exports = { fitInside, placement, draw }
