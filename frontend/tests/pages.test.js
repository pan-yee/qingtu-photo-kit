const fs = require('fs')
const path = require('path')
const harness = require('./harness')

const assert = harness.assert
const test = harness.test

const miniprogram = path.join(__dirname, '..', 'miniprogram')

function loadModules(registrarName, subdirectory) {
  const entries = []
  let pendingName = ''
  global[registrarName] = function register(options) {
    entries.push({ name: pendingName, options: options })
  }
  const directory = path.join(miniprogram, subdirectory)
  fs.readdirSync(directory).forEach(function load(name) {
    const file = path.join(directory, name, 'index.js')
    if (!fs.existsSync(file)) return
    pendingName = name
    require(file)
  })
  return entries
}

const pageModules = loadModules('Page', 'pages')
const componentModules = loadModules('Component', 'components')

// pages/index/index 只做旧入口兼容跳转，没有初始状态。
const REDIRECT_PAGES = ['index']

test('页面模块都能注册并声明初始状态', function () {
  const expected = fs.readdirSync(path.join(miniprogram, 'pages')).length
  assert.strictEqual(pageModules.length, expected, '存在未能注册的页面模块')
  pageModules.forEach(function validate(entry) {
    assert(entry.options, '页面 ' + entry.name + ' 未注册')
    if (REDIRECT_PAGES.indexOf(entry.name) >= 0) {
      assert.strictEqual(
        typeof entry.options.onLoad,
        'function',
        '跳转页 ' + entry.name + ' 缺少 onLoad'
      )
      return
    }
    assert(
      typeof entry.options.data === 'object',
      '页面 ' + entry.name + ' 缺少 data'
    )
  })
})

test('页面成员都是方法，不存在误放的配置字段', function () {
  pageModules.forEach(function validate(entry) {
    Object.keys(entry.options).forEach(function checkMember(name) {
      if (name === 'data') return
      assert.strictEqual(
        typeof entry.options[name],
        'function',
        '页面 ' + entry.name + ' 的成员 ' + name + ' 必须是方法'
      )
    })
  })
})

test('组件模块都能注册并声明 methods', function () {
  assert.strictEqual(componentModules.length, 1)
  const component = componentModules[0].options
  assert(component.methods, '隐私弹窗组件缺少 methods')
  assert.strictEqual(typeof component.methods.agreePrivacy, 'function')
})
