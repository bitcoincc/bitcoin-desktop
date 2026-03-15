// Electron main process — thin wrapper around the web app
// Optionally runs JSS (JavaScript Solid Server) to serve blocks

import { app, BrowserWindow } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { spawn } from 'child_process'

const DATA_DIR = join(homedir(), '.bitcoin-desktop')
const CONFIG_FILE = join(DATA_DIR, 'config.json')

let jssProcess = null

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    title: 'Bitcoin Desktop',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  })

  win.loadFile('index.html')

  // Start JSS if configured
  try {
    let config = {}
    if (existsSync(CONFIG_FILE)) {
      config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    }

    if (config.serveBlocks) {
      const port = config.serverPort || 8443
      const jssPath = join(import.meta.dirname, 'node_modules', '.bin', 'jss')

      jssProcess = spawn(jssPath, [
        'start',
        '--port', String(port),
        '--root', DATA_DIR,
        '--no-multiuser',
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TOKEN_SECRET: 'bitcoin-desktop' }
      })

      jssProcess.stdout.on('data', d => console.log('[jss]', d.toString().trim()))
      jssProcess.stderr.on('data', d => console.error('[jss]', d.toString().trim()))
      jssProcess.on('error', e => console.log('[jss] failed to start:', e.message))
      jssProcess.on('exit', code => console.log('[jss] exited with code', code))

      console.log(`[jss] starting on port ${port}, root: ${DATA_DIR}`)
    }
  } catch (err) {
    console.log('[jss] error:', err.message)
  }
})

app.on('window-all-closed', () => {
  if (jssProcess) jssProcess.kill()
  if (process.platform !== 'darwin') app.quit()
})
