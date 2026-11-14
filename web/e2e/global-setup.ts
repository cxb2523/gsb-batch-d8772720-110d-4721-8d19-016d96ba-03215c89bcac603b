import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** A port that is free right now (the OS picks it), so a stale server cannot block the run. */
function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', fail)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : 0
      srv.close(() => ok(port))
    })
  })
}

/** Signal the whole process group (`uv run` starts a Python child that must die too). */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    // group already gone
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const repo = resolve(import.meta.dirname, '..', '..')
  const home = mkdtempSync(join(tmpdir(), 'mecha-e2e-'))
  const port = await freePort()
  // detached: the server leads its own process group, so teardown can kill all of it.
  const child = spawn(
    'uv',
    ['run', 'mecha', 'serve', '--demo', '--no-open', '--port', String(port)],
    {
      cwd: repo,
      env: { ...process.env, MECHA_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  )
  const exited = new Promise<void>((r) => child.once('exit', () => r()))
  const url = await new Promise<string>((ok, fail) => {
    let out = ''
    const timer = setTimeout(() => fail(new Error(`server did not start:\n${out}`)), 60_000)
    const onData = (chunk: Buffer) => {
      out += chunk.toString()
      const m = out.match(/Open: (http:\/\/\S+)/)
      if (m && out.includes('Uvicorn running')) {
        clearTimeout(timer)
        ok(m[1] as string)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('exit', (code) => fail(new Error(`server exited (${code}):\n${out}`)))
  })
  writeFileSync(join(import.meta.dirname, '.session-url'), url)
  return async () => {
    killGroup(child, 'SIGINT')
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 5_000))
    if ((await Promise.race([exited, timeout])) === 'timeout') killGroup(child, 'SIGKILL')
  }
}
