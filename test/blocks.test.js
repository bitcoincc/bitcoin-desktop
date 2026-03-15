import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Can't test headers.js or blocks.js directly — they import hash-wasm from CDN
// which Node.js can't resolve. Test what we can without changing source code.

describe('Storage', () => {
  const testDir = path.join(os.tmpdir(), 'bitcoin-desktop-test-' + Date.now())
  let Storage

  before(async () => {
    ;({ Storage } = await import('../js/storage.js'))
  })

  it('saves and loads headers', async () => {
    const storage = new Storage('btc')
    storage.isNode = true
    storage.fs = fs
    storage.path = path
    storage.basePath = testDir
    fs.mkdirSync(testDir, { recursive: true })
    fs.mkdirSync(path.join(testDir, 'blocks'), { recursive: true })

    const data = new Uint8Array([1, 2, 3, 4, 5])
    await storage.saveHeaders(data)
    const loaded = await storage.loadHeaders()
    assert.deepStrictEqual(loaded, data)
  })

  it('saves and loads verified info with BigInt', async () => {
    const storage = new Storage('btc')
    storage.isNode = true
    storage.fs = fs
    storage.path = path
    storage.basePath = testDir

    const info = { passed: true, tipHash: 'abc123', work: 12345n }
    await storage.saveVerified(info)
    const loaded = await storage.loadVerified()
    assert.strictEqual(loaded.passed, true)
    assert.strictEqual(loaded.tipHash, 'abc123')
    assert.strictEqual(loaded.work, 12345n)
  })

  it('saves block in epoch subdirectory', async () => {
    const storage = new Storage('btc')
    storage.isNode = true
    storage.fs = fs
    storage.path = path
    storage.basePath = testDir

    const blockData = new Uint8Array([10, 20, 30, 40, 50])
    await storage.saveBlock(940500, blockData)

    const file = path.join(testDir, 'blocks', '466', '940500.bin')
    assert.ok(fs.existsSync(file), 'Block file should exist at epoch/height path')

    const loaded = await storage.loadBlock(940500)
    assert.deepStrictEqual(loaded, blockData)
  })

  it('returns null for missing block', async () => {
    const storage = new Storage('btc')
    storage.isNode = true
    storage.fs = fs
    storage.path = path
    storage.basePath = testDir

    const loaded = await storage.loadBlock(999999)
    assert.strictEqual(loaded, null)
  })

  it('deletes block', async () => {
    const storage = new Storage('btc')
    storage.isNode = true
    storage.fs = fs
    storage.path = path
    storage.basePath = testDir

    await storage.saveBlock(940501, new Uint8Array([1, 2, 3]))
    await storage.deleteBlock(940501)
    const loaded = await storage.loadBlock(940501)
    assert.strictEqual(loaded, null)
  })

  it('saves and loads config', async () => {
    const storage = new Storage('btc')
    storage.isNode = true
    storage.fs = fs
    storage.path = path
    storage.basePath = testDir

    const config = { chain: 'btc', retention: 12 }
    await storage.saveConfig(config)
    const loaded = await storage.loadConfig()
    assert.deepStrictEqual(loaded, config)
  })

  it('epoch directory is correct for various heights', () => {
    assert.strictEqual(Math.floor(0 / 2016), 0)
    assert.strictEqual(Math.floor(2015 / 2016), 0)
    assert.strictEqual(Math.floor(2016 / 2016), 1)
    assert.strictEqual(Math.floor(940500 / 2016), 466)
    assert.strictEqual(Math.floor(940737 / 2016), 466)
  })

  after(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })
})

describe('Config', () => {
  let mergeConfig, computeScore, DEFAULTS, RECIPES

  before(async () => {
    ;({ mergeConfig, computeScore, DEFAULTS, RECIPES } = await import('../js/config.js'))
  })

  it('defaults have correct structure', () => {
    assert.strictEqual(DEFAULTS.chain, 'btc')
    assert.strictEqual(DEFAULTS.retention, 12)
    assert.ok(DEFAULTS.sources.includes('local'))
    assert.ok(DEFAULTS.relays.length > 0)
    assert.ok(DEFAULTS.htfu.h)
    assert.strictEqual(DEFAULTS.htfu.t, false)
  })

  it('mergeConfig preserves defaults when no overrides', () => {
    const config = mergeConfig({})
    assert.strictEqual(config.chain, 'btc')
    assert.strictEqual(config.retention, 12)
    assert.ok(config.htfu.h)
  })

  it('mergeConfig applies overrides', () => {
    const config = mergeConfig({ chain: 'tbtc4', retention: 100 })
    assert.strictEqual(config.chain, 'tbtc4')
    assert.strictEqual(config.retention, 100)
    assert.ok(config.htfu.h) // default preserved
  })

  it('mergeConfig deep merges htfu', () => {
    const config = mergeConfig({ htfu: { t: true } })
    assert.ok(config.htfu.h)  // default
    assert.ok(config.htfu.t)  // override
    assert.strictEqual(config.htfu.f, false) // default
  })

  it('computeScore returns h-only for defaults', () => {
    const score = computeScore(DEFAULTS, { synced: true, relaysConnected: true })
    assert.ok(score >= 100)
    assert.ok(score <= 250)
  })

  it('computeScore maxes at 1000 for full config', () => {
    const config = mergeConfig({ htfu: { h: true, t: true, f: true, u: true }, contributeBlocks: true })
    const score = computeScore(config, { synced: true, relaysConnected: true })
    assert.strictEqual(score, 1000)
  })

  it('recipes have correct scores', () => {
    assert.strictEqual(RECIPES.phone.score, 100)
    assert.strictEqual(RECIPES.full.score, 1000)
    assert.ok(RECIPES.wallet.score > RECIPES.phone.score)
    assert.ok(RECIPES.power.score > RECIPES.wallet.score)
  })

  it('recipes have increasing retention', () => {
    assert.ok(RECIPES.phone.retention < RECIPES.wallet.retention)
    assert.ok(RECIPES.wallet.retention < RECIPES.power.retention)
    assert.ok(RECIPES.power.retention < RECIPES.full.retention)
  })
})

describe('Source modules', () => {
  it('local source returns null without storage', async () => {
    const { default: local } = await import('../js/sources/local.js')
    const result = await local.fetchBlock(0, 'abc', 'btc')
    assert.strictEqual(result, null)
  })

  it('local source returns data with storage', async () => {
    const { default: local } = await import('../js/sources/local.js')
    const { Storage } = await import('../js/storage.js')
    const storage = new Storage('btc')
    storage.isNode = true
    storage.fs = fs
    storage.path = path
    const tmpDir = path.join(os.tmpdir(), 'btc-local-test-' + Date.now())
    storage.basePath = tmpDir
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'blocks'), { recursive: true })

    await storage.saveBlock(100, new Uint8Array([1, 2, 3]))
    local.setStorage(storage)
    const result = await local.fetchBlock(100, 'abc', 'btc')
    assert.deepStrictEqual(result, new Uint8Array([1, 2, 3]))

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('all sources have required interface', async () => {
    const sources = ['local', 'r2', 'blockstream', 'mempool', 'p2p']
    for (const name of sources) {
      const { default: source } = await import(`../js/sources/${name}.js`)
      assert.strictEqual(typeof source.name, 'string', name + ' needs name')
      assert.strictEqual(typeof source.fetchBlock, 'function', name + ' needs fetchBlock')
      assert.strictEqual(typeof source.browser, 'boolean', name + ' needs browser flag')
      assert.strictEqual(typeof source.desktop, 'boolean', name + ' needs desktop flag')
    }
  })

  it('p2p is desktop only, others support browser', async () => {
    const { default: p2p } = await import('../js/sources/p2p.js')
    const { default: bs } = await import('../js/sources/blockstream.js')
    const { default: r2 } = await import('../js/sources/r2.js')
    assert.strictEqual(p2p.browser, false)
    assert.strictEqual(p2p.desktop, true)
    assert.strictEqual(bs.browser, true)
    assert.strictEqual(r2.browser, true)
  })
})

describe('Saved blocks on disk', () => {
  const blocksDir = path.join(os.homedir(), '.bitcoin-desktop', 'btc', 'blocks', '466')

  it('blocks directory exists', () => {
    assert.ok(fs.existsSync(blocksDir), 'Expected blocks at ' + blocksDir)
  })

  it('has block files', () => {
    const files = fs.readdirSync(blocksDir).filter(f => f.endsWith('.bin'))
    assert.ok(files.length > 0, 'Expected at least 1 block file')
  })

  it('block files are valid size (> 80 bytes)', () => {
    const files = fs.readdirSync(blocksDir).filter(f => f.endsWith('.bin'))
    for (const file of files) {
      const stat = fs.statSync(path.join(blocksDir, file))
      assert.ok(stat.size > 80, file + ' should be larger than a header')
    }
  })

  it('block filenames are valid heights', () => {
    const files = fs.readdirSync(blocksDir).filter(f => f.endsWith('.bin'))
    for (const file of files) {
      const height = parseInt(file.replace('.bin', ''))
      assert.ok(!isNaN(height), file + ' should have numeric height')
      assert.ok(height > 900000, file + ' should be recent block')
      assert.strictEqual(Math.floor(height / 2016), 466, file + ' should be in epoch 466')
    }
  })
})
