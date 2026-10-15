import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../lib/index.js'

function routes(cwdDir, persistence) {
  const registered = new Map()
  const settingsStore = { extraProbeRoots: [] }
  const settingsScope = {
    get: () => settingsStore,
    update: async (data) => { Object.assign(settingsStore, data) },
  }
  apply({
    settings: { update: async (_id, patch) => settingsScope.update(patch) },
    webServer: { register: (route) => (registered.set(route.path, route), () => undefined) },
    sessions: { get: () => persistence ? undefined : ({ header: { cwd: cwdDir } }), list: () => [] },
    inject: (_deps, mount) => mount({
      settings: { register: () => settingsScope },
      effect: (install) => { install() },
    }),
    get: (name) => name === 'sessionPersistence' ? persistence : undefined,
    effect: (mount) => { mount() },
  }, { extraProbeRoots: { get: () => settingsStore.extraProbeRoots } })
  return registered
}

function request(body) {
  const req = Readable.from([Buffer.from(body)])
  req.headers = { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }
  req.method = 'POST'
  return req
}

function response() {
  return {
    status: undefined,
    body: undefined,
    writeHead(status) { this.status = status },
    end(body) { this.body = JSON.parse(body) },
  }
}

async function check(cwdDir, paths) {
  const res = response()
  await routes(cwdDir).get('/api/file-mentions/check').handler(
    request(JSON.stringify({ sessionId: 's1', paths })),
    res,
  )
  return res.body
}

// 同实例调用（白名单 store 在同一 routes 内共享）
async function checkOn(routesMap, paths) {
  const res = response()
  await routesMap.get('/api/file-mentions/check').handler(
    request(JSON.stringify({ sessionId: 's1', paths })),
    res,
  )
  return res.body
}

// 2026-08-26 用户拍板：本机目录（家目录内）默认放行，无需白名单；
// 外置盘/网络盘白名单加根目录（任意层级）后其下全部放行。
test('marks home-directory files as valid without whitelist', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'fm-home-'))
  const homeVariable = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'
  const oldHome = process.env[homeVariable]
  process.env[homeVariable] = fakeHome
  const cwd = mkdtempSync(join(tmpdir(), 'fm-cwd-'))
  try {
    const homeFile = join(fakeHome, 'x.txt')
    writeFileSync(homeFile, '')
    // cwd 内文件照旧；home 内文件默认放行；/etc（系统盘）不放行；
    // 与 cwd/home 均无关的 /tmp 目录不放行
    const body = await check(cwd, [homeFile, '/etc/hosts', tmpdir()])
    assert.ok(body.valid.includes(homeFile), 'home 内路径应默认可探测')
    assert.ok(!body.valid.includes('/etc/hosts'), '系统盘路径不可探测')
    assert.ok(!body.valid.includes(tmpdir()), '无关目录不可探测')
  } finally {
    process.env[homeVariable] = oldHome
    rmSync(fakeHome, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('whitelist root opens the whole subtree (subdirectory levels included)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fm-cwd-'))
  const root = mkdtempSync(join(tmpdir(), 'fm-ext-'))
  const sub = join(root, 'sub')
  mkdirSync(sub)
  const deepFile = join(sub, 'f.txt')
  writeFileSync(deepFile, '')
  try {
    const r = routes(cwd)
    // 未加白名单：外置根内路径不可探测
    const body0 = await checkOn(r, [deepFile])
    assert.ok(!body0.valid.includes(deepFile))
    // 通过 config 路由写入白名单（同源 POST，同一 routes 实例共享 store）
    const cfgRes = response()
    await r.get('/api/file-mentions/config').handler(
      request(JSON.stringify({ extraProbeRoots: [root] })), cfgRes,
    )
    assert.equal(cfgRes.status, 200)
    // 加根目录（顶层）→ 其下所有层级放行
    const body1 = await checkOn(r, [deepFile])
    assert.ok(body1.valid.includes(deepFile), '白名单根下子目录文件应可探测')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})


test('checks cold persisted sessions without activating them and rejects unknown ids', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fm-cold-'))
  try {
    writeFileSync(join(cwd, 'cold.txt'), 'persisted')
    const persistence = {
      stat: async id => id === 's1' ? { header: { cwd } } : undefined,
      list: async () => [{ header: { cwd } }],
    }
    const registered = routes(cwd, persistence)
    const res = response()
    await registered.get('/api/file-mentions/check').handler(
      request(JSON.stringify({ sessionId: 's1', paths: ['cold.txt'] })), res,
    )
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.valid, ['cold.txt'])
    const missing = response()
    await registered.get('/api/file-mentions/check').handler(
      request(JSON.stringify({ sessionId: 'missing', paths: ['cold.txt'] })), missing,
    )
    assert.equal(missing.status, 400)
    const absent = response()
    await registered.get('/api/file-mentions/open').handler(
      request(JSON.stringify({ sessionId: 's1', path: 'absent.txt' })), absent,
    )
    assert.equal(absent.status, 404)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('resolves fallback directories from current persistence snapshots', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fm-current-'))
  const other = mkdtempSync(join(tmpdir(), 'fm-other-'))
  try {
    writeFileSync(join(other, 'fallback.txt'), 'persisted')
    const registered = routes(cwd, {
      stat: async () => ({ header: { cwd } }),
      list: async () => [{ header: { cwd: other } }],
    })
    const body = await checkOn(registered, ['fallback.txt'])
    assert.deepEqual(body.valid, ['fallback.txt'])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})
