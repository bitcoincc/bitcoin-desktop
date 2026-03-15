#!/usr/bin/env node
/**
 * Headless mode — runs bitcoin-desktop without Electron/GUI
 * Syncs headers, downloads blocks, serves via JSS
 *
 * Usage: node headless.js [--chain btc|tbtc4]
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { spawn } from 'child_process'

const DATA_DIR = join(homedir(), '.bitcoin-desktop')
const CONFIG_FILE = join(DATA_DIR, 'config.json')

let config = {}
if (existsSync(CONFIG_FILE)) {
  config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
}

const chain = process.argv.includes('--chain')
  ? process.argv[process.argv.indexOf('--chain') + 1]
  : config.chain || 'btc'

console.log('═══════════════════════════════')
console.log('  bitcoin.desktop (headless)')
console.log('═══════════════════════════════')
console.log(`Chain: ${chain}`)
console.log(`Data: ${DATA_DIR}`)

// Start JSS if configured
if (config.serveBlocks) {
  const port = config.serverPort || 8443
  const jssPath = join(import.meta.dirname, 'node_modules', '.bin', 'jss')

  const jss = spawn(jssPath, [
    'start', '--port', String(port), '--root', DATA_DIR, '--no-multiuser',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TOKEN_SECRET: 'bitcoin-desktop' }
  })

  jss.stdout.on('data', d => console.log('[jss]', d.toString().trim()))
  jss.stderr.on('data', d => {})
  console.log(`JSS serving on port ${port}`)

  process.on('SIGINT', () => { jss.kill(); process.exit() })
}

// Import and start the app
const { BitcoinDesktop } = await import('./js/app.js')

const app = new BitcoinDesktop(chain, config)

app.addEventListener('status', (e) => {
  const d = e.detail
  if (d.phase === 'download') console.log(`[${d.phase}] ${d.status}${d.height ? ' h=' + d.height : ''}`)
  if (d.phase === 'verify' && d.status === 'done') console.log(`[verify] ${d.passed ? 'passed' : 'ERRORS'} in ${d.elapsed}s`)
  if (d.phase === 'verify' && d.status === 'cached') console.log('[verify] cached')
  if (d.phase === 'ready') console.log(`[ready] tip: ${d.height}`)
  if (d.phase === 'live') console.log(`[live] tip: ${d.height}`)
  if (d.phase === 'blocks' && d.status === 'done') console.log(`[blocks] ${d.cached} cached`)
})

app.addEventListener('newblock', (e) => {
  console.log(`[block] ${e.detail.height}`)
})

app.blocks.addEventListener('fetched', (e) => {
  const sizeMB = (e.detail.size / 1024 / 1024).toFixed(2)
  console.log(`[fetched] ${e.detail.height} ${sizeMB}MB via ${e.detail.source}`)
  if (e.detail.block) {
    app.storage.saveBlock(e.detail.height, e.detail.block).catch(() => {})
    app.uploader.upload(e.detail.height, e.detail.block).catch(() => {})
  }
})

console.log('\nStarting...')
app.start((phase, done, total) => {
  if (phase === 'verify' && done % 100000 === 0) process.stdout.write(`  verify ${done}/${total}\r`)
}).catch(e => console.error('Error:', e.message))
