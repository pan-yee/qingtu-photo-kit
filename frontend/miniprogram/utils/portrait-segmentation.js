// MediaPipe Selfie Segmentation，Apache-2.0；模型随代码包分发，图片不离开设备。
const MODEL_PATH = 'models/selfie-segmentation.onnx'
const SIDE = 256

function sample(data, width, height, x, y, channels, channel) {
  const safeX = Math.max(0, Math.min(width - 1, x))
  const safeY = Math.max(0, Math.min(height - 1, y))
  const left = Math.floor(safeX)
  const top = Math.floor(safeY)
  const right = Math.min(width - 1, left + 1)
  const bottom = Math.min(height - 1, top + 1)
  const dx = safeX - left
  const dy = safeY - top
  const a = data[(top * width + left) * channels + channel]
  const b = data[(top * width + right) * channels + channel]
  const c = data[(bottom * width + left) * channels + channel]
  const d = data[(bottom * width + right) * channels + channel]
  return (a * (1 - dx) + b * dx) * (1 - dy) + (c * (1 - dx) + d * dx) * dy
}

function createInput(image) {
  const input = new Float32Array(SIDE * SIDE * 3)
  for (let y = 0; y < SIDE; y += 1) {
    for (let x = 0; x < SIDE; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        input[channel * SIDE * SIDE + y * SIDE + x] = sample(
          image.data, image.width, image.height,
          (x + 0.5) * image.width / SIDE - 0.5,
          (y + 0.5) * image.height / SIDE - 0.5, 4, channel
        ) / 255
      }
    }
  }
  return input
}

function readMask(result) {
  const tensor = result && result.activation_10
  if (!tensor || tensor.type !== 'float32' ||
      !Array.isArray(tensor.shape) || tensor.shape.join(',') !== '1,1,256,256') {
    throw new Error('人像分割结果格式不正确')
  }
  const data = tensor.data instanceof Float32Array
    ? tensor.data : new Float32Array(tensor.data)
  if (data.length !== SIDE * SIDE) throw new Error('人像分割结果尺寸不正确')
  let foreground = 0
  for (let i = 0; i < data.length; i += 1) {
    if (data[i] > 0.5) foreground += 1
    if (!Number.isFinite(data[i]) || data[i] < -0.001 || data[i] > 1.001) {
      throw new Error('人像分割结果无效')
    }
  }
  if (foreground < SIDE * SIDE * 0.005) {
    const error = new Error('未检测到清晰人像，请选择单人正面半身照')
    error.code = 'NO_PORTRAIT'
    throw error
  }
  // 引擎可能在下一次推理时复用输出缓冲。
  return new Float32Array(data)
}

function applyPortraitMask(image, mask, options) {
  const matting = mask && mask.matting === true
  const values = matting ? mask.data : mask
  const maskWidth = matting ? mask.width : SIDE
  const maskHeight = matting ? mask.height : SIDE
  if (!(values instanceof Float32Array) || values.length !== maskWidth * maskHeight) {
    throw new Error('人像遮罩尺寸不正确')
  }
  const opts = options || {}
  const output = opts.output && opts.output.length === image.data.length
    ? opts.output : new Uint8ClampedArray(image.data.length)
  output.set(image.data)
  const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : 36
  const feather = Number.isFinite(opts.featherRadius) ? opts.featherRadius : 3
  const midpoint = Math.max(0.2, Math.min(0.8, 0.5 + (tolerance - 36) / 150))
  const softness = Math.max(0, Math.min(0.3, feather * 0.04))
  // Adjust uncertain edges, never add opacity to a cleared background or
  // subtract it from an opaque face/clothing pixel. Neutral remains identity.
  const edgeScale = Math.pow(2, (Math.max(12, Math.min(82, tolerance)) - 36) / 24)
  let removedPixels = 0
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const probability = sample(values, maskWidth, maskHeight,
        (x + 0.5) * maskWidth / image.width - 0.5,
        (y + 0.5) * maskHeight / image.height - 0.5, 1, 0)
      let alpha = probability >= midpoint ? 1 : 0
      if (softness > 0) {
        const t = Math.max(0, Math.min(1,
          (probability - midpoint + softness) / (2 * softness)))
        alpha = t * t * (3 - 2 * t)
      }
      // MODNet already predicts alpha, not class confidence. Preserve hair transparency.
      if (matting) {
        // Keep the historical default neutral; extra feathering is a spatial
        // blur, rather than a nonlinear remap that hardens translucent hair.
        let matte = probability
        if (feather > 3) {
          const mx = (x + .5) * maskWidth / image.width - .5
          const my = (y + .5) * maskHeight / image.height - .5
          const radius = Math.min(3, (feather - 3) * .5)
          matte = probability * .5 + .125 * (
            sample(values, maskWidth, maskHeight, mx - radius, my, 1, 0) +
            sample(values, maskWidth, maskHeight, mx + radius, my, 1, 0) +
            sample(values, maskWidth, maskHeight, mx, my - radius, 1, 0) +
            sample(values, maskWidth, maskHeight, mx, my + radius, 1, 0))
        }
        matte = Math.max(0, Math.min(1, matte))
        alpha = matte / (matte + (1 - matte) * edgeScale)
      }
      const offset = (y * image.width + x) * 4 + 3
      output[offset] = Math.round(image.data[offset] * alpha)
      if (output[offset] === 0) removedPixels += 1
    }
  }
  if (matting && opts.edgeCleanup) cleanEdgeColors(image, output)
  return { data: output, removedPixels: removedPixels }
}

function cleanEdgeColors(image, output) {
  const width = image.width, height = image.height
  let hasBackground = false
  for (let offset = 3; offset < output.length; offset += 4) {
    if (output[offset] <= 5 && image.data[offset] >= 250) { hasBackground = true; break }
  }
  if (!hasBackground) return
  // Only use nearby, confidently removed background. Do not alter opaque
  // face/clothing pixels or guess a global background for complex scenes.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const alpha = output[offset + 3] / 255
      if (alpha < .15 || alpha > .95 || image.data[offset + 3] < 250) continue
      let background = -1
      for (let distance = 2; distance <= 8 && background < 0; distance *= 2) {
        for (let direction = 0; direction < 4; direction += 1) {
          const nx = x + (direction === 0 ? -distance : direction === 1 ? distance : 0)
          const ny = y + (direction === 2 ? -distance : direction === 3 ? distance : 0)
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
          const candidate = (ny * width + nx) * 4
          if (output[candidate + 3] <= 5 && image.data[candidate + 3] >= 250) {
            background = candidate
            break
          }
        }
      }
      if (background < 0) continue
      for (let channel = 0; channel < 3; channel += 1) {
        const color = image.data[offset + channel]
        const foreground = (color - (1 - alpha) * image.data[background + channel]) / alpha
        // Conservative correction cap; users can disable it for unusual edges.
        output[offset + channel] = Math.round(color + Math.max(-32, Math.min(32, foreground - color)) * .6)
      }
    }
  }
}

function createSegmenter() {
  let session = null
  let loading = null
  let rejectLoading = null
  let disposed = false
  let timer = null
  let runTimer = null
  let rejectRun = null

  function dispose() {
    disposed = true
    clearTimeout(timer)
    clearTimeout(runTimer)
    if (rejectRun) rejectRun(new Error('人像处理已取消'))
    rejectRun = null
    if (rejectLoading) rejectLoading(new Error('人像处理已取消'))
    rejectLoading = null
    if (session) session.destroy()
    session = null
  }

  function load() {
    if (disposed) return Promise.reject(new Error('人像处理已取消'))
    if (loading) return loading
    loading = new Promise(function initialize(resolve, reject) {
      rejectLoading = reject
      if (typeof wx.createInferenceSession !== 'function') {
        reject(new Error('当前微信版本不支持本机人像分割'))
        return
      }
      session = wx.createInferenceSession({
        model: MODEL_PATH, precisionLevel: 4, allowNPU: false, allowQuantize: false
      })
      timer = setTimeout(function timeout() {
        reject(new Error('人像模型加载超时'))
      }, 15000)
      session.onError(function failed() {
        clearTimeout(timer)
        reject(new Error('当前设备无法加载人像模型'))
      })
      session.onLoad(function loaded() {
        clearTimeout(timer)
        rejectLoading = null
        resolve(session)
      })
    })
    return loading
  }

  async function segment(image) {
    const engine = await load()
    if (disposed) throw new Error('人像处理已取消')
    const input = createInput(image)
    let result
    try {
      result = await Promise.race([
        engine.run({
          input_1: { type: 'float32', shape: [1, 3, SIDE, SIDE], data: input.buffer }
        }),
        new Promise(function deadline(resolve, reject) {
          rejectRun = reject
          runTimer = setTimeout(function timedOut() {
            reject(new Error('人像分割超时'))
          }, 15000)
        })
      ])
    } finally {
      clearTimeout(runTimer)
      rejectRun = null
    }
    if (disposed) throw new Error('人像处理已取消')
    return readMask(result)
  }

  return { segment: segment, dispose: dispose }
}

module.exports = { applyPortraitMask, createInput, createSegmenter, readMask }
