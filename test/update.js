'use strict'

const { mkdtemp, readFile, readdir } = require('fs/promises')
const os = require('os')
const path = require('path')
const test = require('ava')

const { writeAll } = require('../bin/update')

test('writeAll publishes index, desktop and mobile together', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'top-user-agents-'))

  await writeAll(
    { index: ['a', 'b'], desktop: ['a'], mobile: ['b'] },
    dir
  )

  // no temporary files are left behind after the rename
  t.deepEqual((await readdir(dir)).sort(), [
    'desktop.json',
    'index.json',
    'mobile.json'
  ])

  const read = async name =>
    JSON.parse(await readFile(path.join(dir, name), 'utf8'))
  const [index, desktop, mobile] = await Promise.all([
    read('index.json'),
    read('desktop.json'),
    read('mobile.json')
  ])

  t.deepEqual(index, ['a', 'b'])
  t.deepEqual([...desktop, ...mobile].sort(), [...index].sort())
})
