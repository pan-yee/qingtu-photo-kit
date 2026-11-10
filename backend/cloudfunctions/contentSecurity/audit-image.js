const sharp = require('sharp')
const MAX_AUDIT_BYTES = 1024 * 1024
sharp.cache({ memory: 16, files: 0, items: 16 })
sharp.concurrency(1)
let active = 0

async function prepareAuditImage(input) {
  if (active >= 1) throw new Error('Audit image processing busy')
  active += 1
  try { return await prepare(input) } finally { active -= 1 }
}

async function prepare(input) {
  if (!Buffer.isBuffer(input) || !input.length || input.length > 10 * MAX_AUDIT_BYTES) {
    throw new Error('Invalid audit image')
  }
  const options = { limitInputPixels: 24 * 1000 * 1000, failOn: 'error', sequentialRead: true }
  const metadata = await sharp(input, options).metadata()
  if (!['jpeg', 'png'].includes(metadata.format) || !metadata.width || !metadata.height ||
      metadata.pages > 1) throw new Error('Unsupported audit image')
  const image = sharp(input, options).rotate().flatten({ background: '#ffffff' })
    .resize({ width: 750, height: 1334, fit: 'inside', withoutEnlargement: true })
  let output = await image.clone().jpeg({ quality: 80 }).toBuffer()
  if (output.length >= MAX_AUDIT_BYTES) output = await image.clone().jpeg({ quality: 60 }).toBuffer()
  if (!output.length || output.length >= MAX_AUDIT_BYTES) throw new Error('Audit copy too large')
  return output
}

module.exports = { prepareAuditImage }
