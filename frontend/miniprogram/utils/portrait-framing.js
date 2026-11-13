// Geometry only. Keep identity pixels intact; this is not an ID eligibility check.
function fitSize(width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

function validFace(face) {
  return face && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(face[key])) &&
    face.x >= 0 && face.y >= 0 && face.width > 0 && face.height > 0 &&
    face.x + face.width <= 1.001 && face.y + face.height <= 1.001
}

function maskInfo(mask) {
  return mask.matting ? mask : { data: mask, width: 256, height: 256 }
}

function sample(mask, x, y) {
  if (mask.region) {
    x = (x - mask.region.x) / mask.region.width
    y = (y - mask.region.y) / mask.region.height
  }
  if (x < 0 || y < 0 || x > 1 || y > 1) return 0
  const mx = Math.max(0, Math.min(mask.width - 1, x * mask.width - .5))
  const my = Math.max(0, Math.min(mask.height - 1, y * mask.height - .5))
  const x0 = Math.floor(mx), y0 = Math.floor(my)
  const x1 = Math.min(mask.width - 1, x0 + 1), y1 = Math.min(mask.height - 1, y0 + 1)
  const tx = mx - x0, ty = my - y0
  return (mask.data[y0 * mask.width + x0] * (1 - tx) + mask.data[y0 * mask.width + x1] * tx) * (1 - ty) +
    (mask.data[y1 * mask.width + x0] * (1 - tx) + mask.data[y1 * mask.width + x1] * tx) * ty
}

function portraitCrop(width, height, face, mask, targetWidth, targetHeight) {
  const ratio = targetWidth / targetHeight
  if (!validFace(face)) {
    const sh = Math.min(height, width / ratio)
    const sw = sh * ratio
    return { sx: (width - sw) / 2, sy: (height - sh) / 2, sw, sh, faceAligned: false }
  }
  const info = maskInfo(mask)
  // Walk up from the forehead within the main face column to include hair.
  let headTop = Math.max(0, face.y - face.height * .25)
  let emptyRows = 0
  const rowStep = (info.region ? info.region.height : 1) / info.height
  for (let y = face.y; y >= Math.max(0, face.y - face.height * .8); y -= rowStep) {
    let occupied = 0
    for (let step = 0; step < 9; step += 1) {
      if (sample(info, face.x + face.width * (.15 + step * .0875), y) > .5) occupied += 1
    }
    if (occupied >= 2) { headTop = y; emptyRows = 0 }
    else if (++emptyRows >= 3) break
  }
  const headHeight = (face.y + face.height - headTop) * height
  // Fit the lower edge inside the source. Padding below a cropped torso creates
  // a visible background stripe and cannot invent the missing shoulders.
  const sh = Math.min(height * 2, (height - headTop * height) / .91,
    Math.max(headHeight / .54, face.width * width / (.52 * ratio)))
  const sw = sh * ratio
  // Allow transparent padding instead of shifting the head to fit image bounds.
  return { sx: (face.x + face.width / 2) * width - sw / 2,
    sy: headTop * height - sh * .09, sw, sh, faceAligned: true }
}

function cropMask(mask, crop, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const info = maskInfo(mask)
  // Sample directly onto the render grid; an intermediate 450x600 grid
  // discards fine alpha detail and adds a second interpolation on export.
  const width = mask.matting ? (targetWidth || 450) : 256
  const height = mask.matting ? (targetHeight || 600) : 256
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 2048)) {
    throw new Error('人像遮罩目标尺寸不正确')
  }
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = sample(info,
        (crop.sx + (x + .5) * crop.sw / width) / sourceWidth,
        (crop.sy + (y + .5) * crop.sh / height) / sourceHeight)
    }
  }
  return mask.matting ? { data, width, height, matting: true } : data
}

function validPortraitCrop(width, height, face, crop) {
  if (!validFace(face) || !crop || crop.faceAligned !== true ||
      !['sx', 'sy', 'sw', 'sh'].every(key => Number.isFinite(crop[key])) ||
      crop.sw <= 0 || crop.sh <= 0 || crop.sw > width * 1.5 || crop.sh > height * 1.5) return false
  const left = face.x * width, top = face.y * height
  const right = (face.x + face.width) * width, bottom = (face.y + face.height) * height
  return left >= crop.sx + crop.sw * .02 && right <= crop.sx + crop.sw * .98 &&
    top >= crop.sy + crop.sh * .02 && bottom <= crop.sy + crop.sh * .98
}

module.exports = { fitSize, validFace, portraitCrop, cropMask, validPortraitCrop }
