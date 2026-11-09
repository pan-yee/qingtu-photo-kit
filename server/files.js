const crypto = require('crypto')
const fs = require('fs/promises')
const path = require('path')
const { imageType } = require('../cloudfunctions/contentSecurity/service')
const TTL = 10 * 60000

async function createFiles(config) {
  await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 })
  function filename(id) {
    if (/^moderation-private\/[a-f0-9]{32}\.(jpg|png)$/.test(id || '')) return id.split('/')[1]
    if (/^moderation-inbox\/[\w-]{10,128}\/[a-f0-9]{32}$/.test(id || '')) {
      return crypto.createHash('sha256').update(id).digest('hex') + '.upload'
    }
    throw new Error('Invalid file ID')
  }
  function location(id) { return path.join(config.dataDir, filename(id)) }
  function signature(name, expires) {
    return crypto.createHmac('sha256', config.mediaSecret).update(name + ':' + expires).digest('hex')
  }
  return {
    isUploadForJob: (id, uploadPath) => id === uploadPath,
    async upload(id, bytes) {
      imageType(bytes)
      await fs.writeFile(location(id), bytes, { flag: 'wx', mode: 0o600 })
    },
    async read(id) { return fs.readFile(location(id)) },
    async write(id, bytes) {
      await fs.writeFile(location(id), bytes, { flag: 'wx', mode: 0o600 })
      return id
    },
    async url(id) {
      const name = filename(id)
      if (!/^[a-f0-9]{32}\.(jpg|png)$/.test(name)) throw new Error('Private media required')
      const expires = Date.now() + TTL
      return config.publicBaseUrl + '/media/' + name + '?expires=' + expires + '&signature=' + signature(name, expires)
    },
    async signedFile(name, expires, actual) {
      if (!/^[a-f0-9]{32}\.(jpg|png)$/.test(name) || !/^\d{13}$/.test(String(expires)) ||
          Number(expires) <= Date.now() || Number(expires) > Date.now() + TTL ||
          !/^[a-f0-9]{64}$/.test(actual || '')) throw new Error('Invalid media signature')
      const expected = signature(name, expires)
      if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) throw new Error('Invalid media signature')
      const target = path.join(config.dataDir, name)
      const stat = await fs.stat(target)
      if (stat.mtimeMs + TTL <= Date.now()) throw new Error('Expired media')
      return target
    },
    async remove(ids) {
      await Promise.all(ids.map(async function (id) {
        try { await fs.unlink(location(id)) } catch (error) { if (error.code !== 'ENOENT') throw error }
      }))
    },
    async prune(now = Date.now()) {
      for (const name of await fs.readdir(config.dataDir)) {
        if (!/^(?:[a-f0-9]{32}\.(?:jpg|png)|[a-f0-9]{64}\.upload)$/.test(name)) continue
        const target = path.join(config.dataDir, name)
        try {
          const stat = await fs.stat(target)
          if (stat.mtimeMs + TTL < now) await fs.unlink(target)
        } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
    }
  }
}
module.exports = { createFiles }
