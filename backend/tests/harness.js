const assert = require('assert')

const queue = []
let failed = 0

function test(name, fn) {
  queue.push({ name: name, fn: fn })
}

async function runAll(label) {
  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i]
    try {
      await item.fn()
      console.log('  ok   ' + item.name)
    } catch (error) {
      failed += 1
      const message = (error && error.message) || String(error)
      console.log('  FAIL ' + item.name)
      console.log(
        message
          .split('\n')
          .map(function indent(line) {
            return '       ' + line
          })
          .join('\n')
      )
    }
  }

  console.log('')
  if (failed > 0) {
    console.log(label + ': ' + failed + ' of ' + queue.length + ' failed')
    process.exitCode = 1
    return
  }
  console.log(label + ': ' + queue.length + ' passed')
}

module.exports = {
  assert,
  runAll,
  test
}
