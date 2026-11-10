const fs = require('fs')
const path = require('path')
const harness = require('./harness')

const directory = __dirname
const files = fs
  .readdirSync(directory)
  .filter(function match(name) {
    return /\.test\.js$/.test(name)
  })
  .sort()

if (!files.length) {
  console.error('No *.test.js files found in ' + directory)
  process.exit(1)
}

files.forEach(function load(file) {
  console.log('# ' + file)
  require(path.join(directory, file))
})
console.log('')

harness.runAll('Tests').catch(function failed(error) {
  console.error(error)
  process.exitCode = 1
})
