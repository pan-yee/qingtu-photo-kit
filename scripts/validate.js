const fs = require('fs')
const path = require('path')
const vm = require('vm')

const root = path.resolve(__dirname, '..')
const miniprogram = path.join(root, 'miniprogram')
const appJsonPath = path.join(miniprogram, 'app.json')
const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'))
const errors = []

appJson.pages.forEach(function checkPage(page) {
  ;['js', 'json', 'wxml', 'wxss'].forEach(function checkExtension(ext) {
    const file = path.join(miniprogram, page + '.' + ext)
    if (!fs.existsSync(file)) {
      errors.push('Missing page file: ' + path.relative(root, file))
    }
  })
})

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

