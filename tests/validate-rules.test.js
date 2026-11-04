const checks = require('../scripts/checks')
const harness = require('./harness')

const assert = harness.assert
const test = harness.test

test('wx:for 缺少 wx:key 时被检出', function () {
  assert.deepStrictEqual(
    checks.findTagsWithoutKey('<view class="row" wx:for="{{items}}">x</view>'),
    ['view']
  )
  assert.deepStrictEqual(
    checks.findTagsWithoutKey(
      '<block wx:for="{{cells}}" wx:key="index"><image /></block>'
    ),
    []
  )
})

test('wx:for 的多种写法都能识别', function () {
  const template = [
    '<view wx:for="{{a}}">1</view>',
    '<text wx:for-item="item" wx:for="{{b}}">2</text>',
    '<image wx:key="id" wx:for="{{c}}" />',
    "<view wx:key='index' wx:for='{{d}}'>4</view>"
  ].join('\n')
  assert.deepStrictEqual(checks.findTagsWithoutKey(template), ['view', 'text'])
})

test('普通标签不会被误报', function () {
  assert.deepStrictEqual(
    checks.findTagsWithoutKey('<view class="card"><text>标题</text></view>'),
    []
  )
  assert.deepStrictEqual(checks.findTagsWithoutKey(''), [])
})

test('收集模板中的事件绑定名', function () {
  const template = [
    '<button bindtap="onSave">保存</button>',
    '<view catch:touchmove="onMove" data-id="{{item}}">',
    '<slider bind:change="onChange" />',
    '<view bindlongpress="onLongPress"></view>'
  ].join('\n')
  assert.deepStrictEqual(checks.collectEventBindings(template), [
    'onSave',
    'onMove',
    'onChange',
    'onLongPress'
  ])
})

test('事件绑定识别跳过普通属性', function () {
  assert.deepStrictEqual(
    checks.collectEventBindings('<view class="a" hover-class="b"></view>'),
    []
  )
})

test('hasHandler 支持方法与对象两种写法', function () {
  const script = [
    'Page({',
    '  async choosePhoto() {',
    '  },',
    '  onLoad: function (options) {',
    '  },',
    '  methods: {',
    '    agreePrivacy,',
    '    onReject() {}',
    '  }',
    '})'
  ].join('\n')
  assert.strictEqual(checks.hasHandler(script, 'choosePhoto'), true)
  assert.strictEqual(checks.hasHandler(script, 'onLoad'), true)
  assert.strictEqual(checks.hasHandler(script, 'agreePrivacy'), true)
  assert.strictEqual(checks.hasHandler(script, 'onReject'), true)
})

test('hasHandler 不会把前缀相同的方法当成同名', function () {
  const script = 'Page({\n  onTapTap() {}\n})'
  assert.strictEqual(checks.hasHandler(script, 'onTapTap'), true)
  assert.strictEqual(checks.hasHandler(script, 'onTap'), false)
})

test('缺少处理函数时按出现顺序去重返回', function () {
  const template = [
    '<view bindtap="onUndo"></view>',
    '<view bindtap="onUndo"></view>',
    '<view bindtap="onSave"></view>',
    '<view bindtap="onClear"></view>'
  ].join('\n')
  const script = 'Page({\n  onSave() {}\n})'
  assert.deepStrictEqual(checks.findMissingHandlers(template, script), [
    'onUndo',
    'onClear'
  ])
})

test('收集相对路径的 require', function () {
  const source = [
    "const fs = require('fs')",
    "const config = require('../../config/index')",
    'const media = require("./media")',
    "const alias = require('@/utils/media')"
  ].join('\n')
  assert.deepStrictEqual(checks.collectRelativeRequires(source), [
    '../../config/index',
    './media'
  ])
})

test('识别多端架构配置', function () {
  assert.strictEqual(
    checks.isMultiPlatformProject({ projectArchitecture: 'multiPlatform' }),
    true
  )
  assert.strictEqual(
    checks.isMultiPlatformProject({ projectArchitecture: 'miniapp' }),
    true
  )
  assert.strictEqual(
    checks.isMultiPlatformProject({ projectArchitecture: 'miniprogram' }),
    false
  )
  assert.strictEqual(checks.isMultiPlatformProject({}), false)
  assert.strictEqual(checks.isMultiPlatformProject(null), false)
})

test('找出多端架构残留文件', function () {
  const paths = [
    'README.md',
    'project.miniapp.json',
    'project.config.json',
    'miniprogram/app.miniapp.json',
    'i18n',
    'miniprogram/i18n/base.json',
    'miniapp',
    'miniapp/android/nativeResources/res',
    'miniprogram/pages/home/index.js',
    'docs/审核说明.md'
  ]
  assert.deepStrictEqual(checks.findMultiPlatformArtifacts(paths), [
    'project.miniapp.json',
    'miniprogram/app.miniapp.json',
    'i18n',
    'miniprogram/i18n/base.json',
    'miniapp',
    'miniapp/android/nativeResources/res'
  ])
  assert.deepStrictEqual(checks.findMultiPlatformArtifacts([]), [])
})

test('AI 文案规则命中与放行', function () {
  assert.strictEqual(checks.hasAiWording('一键 AI 换底色'), true)
  assert.strictEqual(checks.hasAiWording('人工智能生成'), true)
  assert.strictEqual(checks.hasAiWording('智能抠图'), true)
  assert.strictEqual(checks.hasAiWording('本地像素处理，不上传照片'), false)
  assert.strictEqual(checks.hasAiWording('AIPicture'), false)
  assert.strictEqual(checks.hasAiWording(''), false)
  assert.strictEqual(checks.hasAiWording(undefined), false)
})
