/**
 * Storage layer — filesystem (Electron/Node) or IndexedDB (browser)
 *
 * Structure:
 *   ~/.bitcoin-desktop/btc/headers.bin
 *   ~/.bitcoin-desktop/btc/headers-verified.json
 *   ~/.bitcoin-desktop/btc/blocks/466/940600.bin
 *   ~/.bitcoin-desktop/tbtc4/headers.bin
 *   ...
 *
 * Auto-detects environment: filesystem if Node.js, IndexedDB if browser.
 */

const EPOCH_SIZE = 2016
const DB_NAME = 'bitcoin-desktop'
const DB_VERSION = 1

export class Storage {
  constructor(chain = 'btc') {
    this.chain = chain
    // Electron has both window AND Node.js — prefer filesystem
    this.isNode = typeof process !== 'undefined' && process.versions && process.versions.node
    this.basePath = null  // set in init() for Node
    this.db = null        // set in init() for browser
  }

  async init() {
    if (this.isNode) {
      const os = require('os')
      const path = require('path')
      const fs = require('fs')
      this.fs = fs
      this.path = path
      this.basePath = path.join(os.homedir(), '.bitcoin-desktop', this.chain)
      fs.mkdirSync(this.basePath, { recursive: true })
      fs.mkdirSync(path.join(this.basePath, 'blocks'), { recursive: true })
    } else {
      this.db = await this._openDB()
    }
  }

  _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = (e) => {
        const db = e.target.result
        if (!db.objectStoreNames.contains('headers')) {
          db.createObjectStore('headers')
        }
        if (!db.objectStoreNames.contains('blocks')) {
          db.createObjectStore('blocks')
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta')
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  _idbGet(store, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readonly')
      const req = tx.objectStore(store).get(key)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => reject(req.error)
    })
  }

  _idbPut(store, key, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite')
      const req = tx.objectStore(store).put(value, key)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  }

  _idbDelete(store, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite')
      const req = tx.objectStore(store).delete(key)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  }

  // ── Headers ──

  async saveHeaders(data) {
    if (this.isNode) {
      this.fs.writeFileSync(this.path.join(this.basePath, 'headers.bin'), Buffer.from(data))
    } else {
      await this._idbPut('headers', this.chain, data)
    }
  }

  async loadHeaders() {
    if (this.isNode) {
      const file = this.path.join(this.basePath, 'headers.bin')
      try {
        const buf = this.fs.readFileSync(file)
        return new Uint8Array(buf)
      } catch {
        return null
      }
    } else {
      return this._idbGet('headers', this.chain)
    }
  }

  async saveVerified(info) {
    if (this.isNode) {
      this.fs.writeFileSync(
        this.path.join(this.basePath, 'headers-verified.json'),
        JSON.stringify(info, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2)
      )
    } else {
      const serialized = { ...info, work: info.work?.toString() }
      await this._idbPut('meta', this.chain + '-verified', serialized)
    }
  }

  async loadVerified() {
    if (this.isNode) {
      try {
        const data = this.fs.readFileSync(this.path.join(this.basePath, 'headers-verified.json'), 'utf8')
        const info = JSON.parse(data)
        if (info.work) info.work = BigInt(info.work)
        return info
      } catch {
        return null
      }
    } else {
      const info = await this._idbGet('meta', this.chain + '-verified')
      if (info && info.work) info.work = BigInt(info.work)
      return info
    }
  }

  // ── Blocks ──

  async saveBlock(height, data) {
    if (this.isNode) {
      const epoch = Math.floor(height / EPOCH_SIZE)
      const dir = this.path.join(this.basePath, 'blocks', String(epoch))
      this.fs.mkdirSync(dir, { recursive: true })
      this.fs.writeFileSync(this.path.join(dir, height + '.bin'), Buffer.from(data))
    } else {
      await this._idbPut('blocks', this.chain + '-' + height, data)
    }
  }

  async loadBlock(height) {
    if (this.isNode) {
      const epoch = Math.floor(height / EPOCH_SIZE)
      const file = this.path.join(this.basePath, 'blocks', String(epoch), height + '.bin')
      try {
        return new Uint8Array(this.fs.readFileSync(file))
      } catch {
        return null
      }
    } else {
      return this._idbGet('blocks', this.chain + '-' + height)
    }
  }

  async deleteBlock(height) {
    if (this.isNode) {
      const epoch = Math.floor(height / EPOCH_SIZE)
      const file = this.path.join(this.basePath, 'blocks', String(epoch), height + '.bin')
      try { this.fs.unlinkSync(file) } catch {}
    } else {
      await this._idbDelete('blocks', this.chain + '-' + height)
    }
  }

  // ── Config ──

  async saveConfig(config) {
    if (this.isNode) {
      const configPath = this.path.join(this.path.dirname(this.basePath), 'config.json')
      this.fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    } else {
      await this._idbPut('meta', 'config', config)
    }
  }

  async loadConfig() {
    if (this.isNode) {
      try {
        const configPath = this.path.join(this.path.dirname(this.basePath), 'config.json')
        return JSON.parse(this.fs.readFileSync(configPath, 'utf8'))
      } catch {
        return null
      }
    } else {
      return this._idbGet('meta', 'config')
    }
  }
}
