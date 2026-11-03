const fs = require('fs')
const path = require('path')
const vm = require('vm')

const root = path.resolve(__dirname, '..')
const miniprogram = path.join(root, 'miniprogram')
const appJsonPath = path.join(miniprogram, 'app.json')
const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'))
const projectConfig = JSON.parse(
  fs.readFileSync(path.join(root, 'project.config.json'), 'utf8')
)
const errors = []

if (!/^wx[0-9a-z]{16}$/i.test(projectConfig.appid || '')) {
  errors.push('project.config.json must contain a valid WeChat AppID')
}
if (projectConfig.compileType !== 'miniprogram') {
  errors.push('project.config.json compileType must be miniprogram')
}
if (!projectConfig.libVersion) {
  errors.push('project.config.json must declare a base library version')
}

appJson.pages.forEach(function checkPage(page) {
  ;['js', 'json', 'wxml', 'wxss'].forEach(function checkExtension(ext) {
    const file = path.join(miniprogram, page + '.' + ext)
    if (!fs.existsSync(file)) {
      errors.push('Missing page file: ' + path.relative(root, file))
    }
  })

  const wxml = fs.readFileSync(
    path.join(miniprogram, page + '.wxml'),
    'utf8'
  )
  if (!wxml.includes('<privacy-dialog')) {
    errors.push('Missing privacy dialog on page: ' + page)
  }
})

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
        'Missing component file for ' + name + ': ' + path.relative(root, file)
      )
    }
  })
})

if (appJson.__usePrivacyCheck__ !== true) {
  errors.push('Privacy check must be enabled in app.json')
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(function map(entry) {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(file) : [file]
  })
}

walk(miniprogram).forEach(function validateFile(file) {
  const extension = path.extname(file)
  if (extension === '.json') {
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      errors.push('Invalid JSON: ' + path.relative(root, file))
    }
  }
  if (extension === '.js') {
    try {
      new vm.Script(fs.readFileSync(file, 'utf8'), {
        filename: path.relative(root, file)
      })
    } catch (error) {
      errors.push('Invalid JavaScript: ' + error.message)
    }
  }
  if (
    (extension === '.js' || extension === '.wxml') &&
    /\bAI\b|人工智能|智能抠图|AI 辅助/.test(
      fs.readFileSync(file, 'utf8')
    )
  ) {
    errors.push(
      'AI wording must not appear in the offline utility UI: ' +
        path.relative(root, file)
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
    ' pages, JSON and JavaScript syntax are valid.'
)

