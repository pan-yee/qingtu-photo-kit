/**
 * 静态校验规则集合。这里只做纯文本分析，不访问文件系统，
 * 便于在 tests/validate-rules.test.js 中直接覆盖正反例。
 */

// 纯本地工具小程序，界面文案不出现 AI 相关表述。
const AI_WORDING = /\bAI\b|人工智能|智能抠图|AI 辅助/

function hasAiWording(source) {
  return AI_WORDING.test(source || '')
}

/**
 * 找出缺少 wx:key 的 wx:for 标签名。
 */
function findTagsWithoutKey(source) {
  const tags = []
  const tagPattern = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
  let match
  while ((match = tagPattern.exec(source || ''))) {
    const attrs = match[2]
    if (/\bwx:for\s*=/.test(attrs) && !/\bwx:key\s*=/.test(attrs)) {
      tags.push(match[1])
    }
  }
  return tags
}

/**
 * 收集模板里 bindtap / catch:touchmove 这类事件绑定的处理函数名。
 */
function collectEventBindings(template) {
  const bindings = []
  const pattern = /\b(?:bind|catch)[:\w-]*="([A-Za-z_$][\w$]*)"/g
  let match
  while ((match = pattern.exec(template || ''))) {
    bindings.push(match[1])
  }
  return bindings
}

function escapeName(name) {
  return name.replace(/[$.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 判断脚本里是否定义了同名方法：支持 `name() {}`、`name: function () {}`
 * 与 `methods: { name, ... }` 简写三种写法。
 */
function hasHandler(script, name) {
  const pattern = new RegExp(
    '(^|[\\s,{])' + escapeName(name) + '\\s*[:(,]',
    'm'
  )
  return pattern.test(script || '')
}

/**
 * 返回模板中绑定但脚本里找不到的处理函数名（已去重，保持出现顺序）。
 */
function findMissingHandlers(template, script) {
  const missing = []
  collectEventBindings(template).forEach(function check(name) {
    if (missing.indexOf(name) === -1 && !hasHandler(script, name)) {
      missing.push(name)
    }
  })
  return missing
}

/**
 * 收集脚本里的相对路径 require 目标，需能解析到真实文件。
 */
function collectRelativeRequires(source) {
  const specifiers = []
  const pattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g
  let match
  while ((match = pattern.exec(source || ''))) {
    if (match[1].charAt(0) === '.') {
      specifiers.push(match[1])
    }
  }
  return specifiers
}

/**
 * 项目只发布单端小程序，project.config.json 不应声明其他架构。
 */
function isMultiPlatformProject(projectConfig) {
  const architecture = projectConfig && projectConfig.projectArchitecture
  return Boolean(architecture && architecture !== 'miniprogram')
}

/**
 * 找出微信开发者工具「多端应用」留下的文件：*.miniapp.json、miniapp/ 与 i18n 目录。
 */
function findMultiPlatformArtifacts(paths) {
  return (paths || []).filter(function match(file) {
    const normalized = String(file).split('\\').join('/')
    return (
      /miniapp\.json$/.test(normalized) ||
      /(^|\/)miniapp(\/|$)/.test(normalized) ||
      /(^|\/)i18n(\/|$)/.test(normalized)
    )
  })
}

module.exports = {
  AI_WORDING,
  collectEventBindings,
  collectRelativeRequires,
  findMissingHandlers,
  findMultiPlatformArtifacts,
  findTagsWithoutKey,
  hasAiWording,
  hasHandler,
  isMultiPlatformProject
}
