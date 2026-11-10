// 后端独立语法与项目边界检查，不读取前端或仓库外层文件。
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const root = path.resolve(__dirname, '..')
const errors = []

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(function (entry) {
    if (['node_modules', 'data', 'backups', '.git', '__pycache__'].includes(entry.name)) return []
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(file) : [file]
  })
}

const files = walk(root)
files.forEach(function (file) {
  if (file.endsWith('.json')) {
    try { JSON.parse(fs.readFileSync(file, 'utf8')) }
    catch (error) { errors.push(path.relative(root, file) + ': invalid JSON') }
  }
  if (!file.endsWith('.js')) return
  const source = fs.readFileSync(file, 'utf8')
  try { new vm.Script(source, { filename: file }) }
  catch (error) { errors.push(error.message) }
  const requires = source.matchAll(/require\(\s*['"](\.[^'"]*)['"]\s*\)/g)
  for (const match of requires) {
    const target = path.resolve(path.dirname(file), match[1])
    const relative = path.relative(root, target)
    if (relative === '..' || relative.startsWith('..' + path.sep)) {
      errors.push(path.relative(root, file) + ': imports outside backend: ' + match[1])
      continue
    }
    if (![target, target + '.js', path.join(target, 'index.js')].some(value => fs.existsSync(value))) {
      errors.push(path.relative(root, file) + ': missing relative import: ' + match[1])
    }
  }
})
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
else console.log('Backend JavaScript, JSON and independent project imports are valid.')
