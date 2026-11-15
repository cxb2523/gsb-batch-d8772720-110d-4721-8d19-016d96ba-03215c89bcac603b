'use strict'

const { rename, writeFile } = require('fs/promises')
const path = require('path')
const { top } = require('./util')

const stringify = data => JSON.stringify(data, null, 2)

const writeAll = async (lists, dir = 'src') => {
  // write every file to a temporary sibling first and only then rename
  // them into place, so a failure can never leave a half-updated set
  const names = Object.keys(lists)
  await Promise.all(
    names.map(name =>
      writeFile(path.join(dir, `${name}.json.tmp`), stringify(lists[name]))
    )
  )
  for (const name of names) {
    await rename(path.join(dir, `${name}.json.tmp`), path.join(dir, `${name}.json`))
  }
}

async function main (n) {
  const result = await top(n)

  for (const device of ['desktop', 'mobile']) {
    const topUp = result.toppedUp
      ? `top-up triggered, quota reached after ${result.attempts} fetch rounds`
      : 'quota reached on first fetch'
    console.log(
      `${device}: ${result[device].length} user agents (minimum ${result.minPerDevice}, ${topUp})`
    )
  }

  const userAgents = list => list.map(([userAgent]) => userAgent)
  await writeAll({
    index: userAgents(result.index),
    desktop: userAgents(result.desktop),
    mobile: userAgents(result.mobile)
  })
  console.log(`published ${result.index.length} user agents`)
}

if (require.main === module) {
  main(100)
    .then(() => process.exit(0))
    .catch(error => {
      console.error(`update aborted: ${error.message}`)
      process.exit(1)
    })
}

module.exports = { main, writeAll }
