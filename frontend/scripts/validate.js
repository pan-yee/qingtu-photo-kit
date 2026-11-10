const fs = require('fs')
const path = require('path')
const vm = require('vm')
const checks = require('./checks')

const root = path.resolve(__dirname, '..')
const miniprogram = path.join(root, 'miniprogram')
const appJsonPath = path.join(miniprogram, 'app.json')
const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'))
const projectConfig = JSON.parse(
  fs.readFileSync(path.join(root, 'project.config.json'), 'utf8')
)
const errors = []

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function relative(file) {
  return path.relative(root, file)
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(function map(entry) {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(file) : [file]
  })
}

function listFiles(extension) {
  return walk(miniprogram).filter(function match(file) {
    return path.extname(file) === extension
  })
}

// 项目配置
if (!/^wx[0-9a-z]{16}$/i.test(projectConfig.appid || '')) {
  errors.push('project.config.json must contain a valid WeChat AppID')
}
if (projectConfig.compileType !== 'miniprogram') {
  errors.push('project.config.json compileType must be miniprogram')
}
if (!projectConfig.libVersion) {
  errors.push('project.config.json must declare a base library version')
}

// 项目只发布单端小程序，多端架构的配置与产物都不应保留
const platformArtifacts = checks.findMultiPlatformArtifacts(
  fs.readdirSync(root).concat(
    walk(miniprogram).map(function toRelative(file) {
      return path.relative(root, file).split(path.sep).join('/')
    })
  )
)
if (checks.isMultiPlatformProject(projectConfig) || platformArtifacts.length) {
  errors.push(
    'This project is single-platform only: close the multi-platform mode in WeChat DevTools and remove ' +
      (platformArtifacts.join(', ') || 'projectArchitecture from project.config.json')
  )
}

// 页面注册与磁盘文件必须双向一致，避免出现无法访问的死页面
if (new Set(appJson.pages).size !== appJson.pages.length) {
  errors.push('app.json declares duplicated page paths')
}
const registeredPages = new Set(appJson.pages)
appJson.pages.forEach(function checkPage(page) {
  ;['js', 'json', 'wxml', 'wxss'].forEach(function checkExtension(ext) {
    const file = path.join(miniprogram, page + '.' + ext)
    if (!fs.existsSync(file)) {
      errors.push('Missing page file: ' + relative(file))
    }
  })

  const wxml = read(path.join(miniprogram, page + '.wxml'))
  if (!wxml.includes('<privacy-dialog')) {
    errors.push('Missing privacy dialog on page: ' + page)
  }
  const pageJson = JSON.parse(read(path.join(miniprogram, page + '.json')))
  if (!pageJson.navigationBarTitleText) {
    errors.push('Page should declare navigationBarTitleText: ' + page)
  }
})

walk(path.join(miniprogram, 'pages'))
  .filter(function match(file) {
    return path.basename(file) === 'index.js'
  })
  .forEach(function checkRegistered(file) {
    const page = path
      .relative(miniprogram, file)
      .split(path.sep)
      .join('/')
      .replace(/\.js$/, '')
    if (!registeredPages.has(page)) {
      errors.push('Page is not registered in app.json: ' + page)
    }
  })

// 公共组件
const components = appJson.usingComponents || {}
Object.keys(components).forEach(function checkComponent(name) {
  const componentRoot = path.join(
    miniprogram,
    components[name].replace(/^\//, '')
  )
  ;['js', 'json', 'wxml', 'wxss'].forEach(function checkExtension(ext) {
    const file = componentRoot + '.' + ext
    if (!fs.existsSync(file)) {
      errors.push(
        'Missing component file for ' + name + ': ' + relative(file)
      )
    }
  })
})

// 隐私授权配置
if (appJson.__usePrivacyCheck__ !== true) {
  errors.push('Privacy check must be enabled in app.json')
}
if (
  appJson.permission &&
  appJson.permission['scope.writePhotosAlbum']
) {
  errors.push(
    'Remove legacy scope.writePhotosAlbum from app.json; declare it in the privacy guide instead'
  )
}

// wxml 结构检查
listFiles('.wxml').forEach(function validateTemplate(file) {
  const source = read(file)
  checks.findTagsWithoutKey(source).forEach(function report(tag) {
    errors.push(
      'wx:for requires wx:key in ' + relative(file) + ': <' + tag + '>'
    )
  })
  if (source.includes('<privacy-dialog') && !components['privacy-dialog']) {
    errors.push(
      'privacy-dialog is used in ' +
        relative(file) +
        ' but not declared in app.json usingComponents'
    )
  }
})

// 事件绑定必须能对应到页面或组件里的同名方法
listFiles('.wxml').forEach(function validateHandlers(file) {
  const scriptFile = file.replace(/\.wxml$/, '.js')
  if (!fs.existsSync(scriptFile)) return
  checks
    .findMissingHandlers(read(file), read(scriptFile))
    .forEach(function report(name) {
      errors.push(
        'Event handler "' + name + '" is missing in ' + relative(scriptFile)
      )
    })
})

listFiles('.json').forEach(function validateJson(file) {
  try {
    JSON.parse(read(file))
  } catch (error) {
    errors.push('Invalid JSON: ' + relative(file))
  }
})

listFiles('.js').forEach(function validateScript(file) {
  const source = read(file)

  try {
    new vm.Script(source, { filename: relative(file) })
  } catch (error) {
    errors.push('Invalid JavaScript: ' + error.message)
  }

  checks.collectRelativeRequires(source).forEach(function checkRequire(target) {
    const resolved = path.resolve(path.dirname(file), target)
    const candidates = [
      resolved,
      resolved + '.js',
      path.join(resolved, 'index.js')
    ]
    const exists = candidates.some(function found(candidate) {
      return fs.existsSync(candidate)
    })
    if (!exists) {
      errors.push(
        'Unresolved require "' + target + '" in ' + relative(file)
      )
    }
  })
})

listFiles('.wxml').forEach(function validateWording(file) {
  if (checks.hasAiWording(read(file))) {
    errors.push(
      'AI wording must not appear in the offline utility UI: ' +
        relative(file)
    )
  }
})

listFiles('.js').forEach(function validateWording(file) {
  if (checks.hasAiWording(read(file))) {
    errors.push(
      'AI wording must not appear in the offline utility UI: ' +
        relative(file)
    )
  }
})

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}

console.log(
  'Validated ' +
    appJson.pages.length +
    ' pages, page registration, event handlers, JSON and JavaScript syntax are valid.'
)
