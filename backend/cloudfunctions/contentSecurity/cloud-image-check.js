// Only WeChat's explicit numeric response may determine the audit result.
function createCloudImageCheck(cloud, prepareImage) {
  return async function checkImage(buffer) {
    const prepare = prepareImage || require('./audit-image').prepareAuditImage
    const image = await prepare(buffer)
    try {
      const result = await cloud.openapi.security.imgSecCheck({ media: { contentType: 'image/jpeg', value: image } })
      const code = result && (result.errCode === undefined ? result.errcode : result.errCode)
      if (code === 0 || code === 87014) return { errcode: code }
      throw new Error('WeChat image check unavailable')
    } catch (error) {
      if (error && (error.errCode === 87014 || error.errcode === 87014)) return { errcode: 87014 }
      throw error
    }
  }
}
module.exports = { createCloudImageCheck }
