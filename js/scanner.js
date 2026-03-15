/**
 * Block scanner — watches for transactions involving our addresses
 *
 * Scans each new block as it arrives for:
 * - Outputs paying to our addresses (incoming payments)
 * - Inputs spending our UTXOs (outgoing spends)
 *
 * Also polls mempool API for unconfirmed transactions.
 */

export class Scanner extends EventTarget {
  constructor(chain = 'btc') {
    super()
    this.chain = chain
    this.addresses = new Set()     // bech32m addresses we watch
    this.scripts = new Map()       // scriptPubkey hex → address
    this.utxos = new Map()         // "txid:vout" → { address, value, height }
    this.history = []              // { txid, type, value, height, timestamp }
    this.lastMempoolCheck = new Map() // address → last known tx count
    this.lastScannedHeight = 0
    this.storage = null
  }

  // Set storage for persistence
  setStorage(storage) {
    this.storage = storage
  }

  // Save wallet state to disk
  async save() {
    if (!this.storage) return
    try {
      const data = {
        utxos: Array.from(this.utxos.entries()).map(([key, val]) => ({ key, ...val })),
        history: this.history.slice(-1000), // keep last 1000 events
        lastScannedHeight: this.lastScannedHeight,
        addresses: Array.from(this.addresses),
        scripts: Array.from(this.scripts.entries()).map(([k, v]) => ({ script: k, address: v })),
      }
      const fs = await this._getFs()
      const path = await this._getPath()
      const dir = path.join(this.storage.basePath, 'wallet')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'utxos.json'), JSON.stringify(data, null, 2))
    } catch {}
  }

  // Load wallet state from disk
  async load() {
    if (!this.storage) return false
    try {
      const fs = await this._getFs()
      const path = await this._getPath()
      const file = path.join(this.storage.basePath, 'wallet', 'utxos.json')
      if (!fs.existsSync(file)) return false
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))

      this.utxos = new Map(data.utxos.map(u => [u.key, { address: u.address, value: u.value, height: u.height }]))
      this.history = data.history || []
      this.lastScannedHeight = data.lastScannedHeight || 0

      for (const addr of (data.addresses || [])) this.addresses.add(addr)
      for (const { script, address } of (data.scripts || [])) this.scripts.set(script, address)

      return true
    } catch {
      return false
    }
  }

  async _getFs() {
    try { return require('fs') } catch { return await import('fs') }
  }
  async _getPath() {
    try { return require('path') } catch { return await import('path') }
  }

  // Add an address to watch
  watch(address, scriptPubkeyHex) {
    this.addresses.add(address)
    this.scripts.set(scriptPubkeyHex, address)
  }

  // Scan a raw block for our transactions
  scanBlock(blockData, blockHeight, blockTime) {
    const block = new Uint8Array(blockData)
    const events = []

    // Parse block: skip 80-byte header, read tx count
    let offset = 80
    const txCount = this._readVarInt(block, offset)
    offset = txCount.next

    for (let t = 0; t < txCount.value; t++) {
      const txStart = offset
      const tx = this._parseTx(block, offset)
      offset = tx.next

      // Check outputs — incoming payments
      for (let i = 0; i < tx.outputs.length; i++) {
        const out = tx.outputs[i]
        const scriptHex = this._bytesToHex(out.script)

        if (this.scripts.has(scriptHex)) {
          const addr = this.scripts.get(scriptHex)
          const utxoKey = tx.txid + ':' + i
          this.utxos.set(utxoKey, { address: addr, value: out.value, height: blockHeight })

          const event = { type: 'receive', txid: tx.txid, vout: i, value: out.value, address: addr, height: blockHeight, timestamp: blockTime, confirmed: true }
          this.history.push(event)
          events.push(event)
        }
      }

      // Check inputs — outgoing spends
      for (const inp of tx.inputs) {
        const utxoKey = inp.prevTxid + ':' + inp.prevVout
        if (this.utxos.has(utxoKey)) {
          const utxo = this.utxos.get(utxoKey)
          this.utxos.delete(utxoKey)

          const event = { type: 'spend', txid: tx.txid, prevTxid: inp.prevTxid, prevVout: inp.prevVout, value: utxo.value, address: utxo.address, height: blockHeight, timestamp: blockTime, confirmed: true }
          this.history.push(event)
          events.push(event)
        }
      }
    }

    this.lastScannedHeight = blockHeight

    if (events.length > 0) {
      this.dispatchEvent(new CustomEvent('transactions', { detail: { events, height: blockHeight } }))
      this.save() // persist on change
    }

    return events
  }

  // Check mempool on demand (called when user presses refresh)
  async checkMempool() {
    const api = this.chain === 'btc'
      ? 'https://mempool.space/api'
      : 'https://mempool.space/testnet4/api'

    for (const address of this.addresses) {
      try {
        const res = await fetch(`${api}/address/${address}`)
        if (!res.ok) continue
        const data = await res.json()

        const mempoolTxCount = data.mempool_stats.tx_count
        const lastCount = this.lastMempoolCheck.get(address) || 0

        if (mempoolTxCount > lastCount) {
          // New mempool activity — fetch details
          const balance = {
            confirmed: data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum,
            unconfirmed: data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum,
          }

          this.dispatchEvent(new CustomEvent('mempool', {
            detail: { address, balance, txCount: mempoolTxCount }
          }))
        }

        this.lastMempoolCheck.set(address, mempoolTxCount)
      } catch { /* offline, skip */ }
    }
  }

  // Get current balance from tracked UTXOs
  getBalance() {
    let total = 0n
    for (const utxo of this.utxos.values()) {
      total += BigInt(utxo.value)
    }
    return total
  }

  // Get list of UTXOs for spending
  getUtxos() {
    return Array.from(this.utxos.entries()).map(([key, data]) => {
      const [txid, vout] = key.split(':')
      return { txid, vout: parseInt(vout), ...data }
    })
  }

  // ─── Transaction parsing ───

  _bytesToHex(b) {
    return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')
  }

  _readVarInt(data, offset) {
    const first = data[offset]
    if (first < 0xfd) return { value: first, next: offset + 1 }
    if (first === 0xfd) return { value: data[offset + 1] | (data[offset + 2] << 8), next: offset + 3 }
    if (first === 0xfe) return { value: data[offset + 1] | (data[offset + 2] << 8) | (data[offset + 3] << 16) | (data[offset + 4] << 24), next: offset + 5 }
    // 0xff — 8 byte, unlikely for tx counts
    return { value: 0, next: offset + 9 }
  }

  _parseTx(data, offset) {
    const start = offset

    // Version (4 bytes)
    offset += 4

    // Check for SegWit marker
    let hasWitness = false
    if (data[offset] === 0x00 && data[offset + 1] === 0x01) {
      hasWitness = true
      offset += 2
    }

    // Inputs
    const inCount = this._readVarInt(data, offset)
    offset = inCount.next
    const inputs = []

    for (let i = 0; i < inCount.value; i++) {
      const prevTxid = this._bytesToHex(data.slice(offset, offset + 32).reverse())
      offset += 32
      const prevVout = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)
      offset += 4
      const scriptLen = this._readVarInt(data, offset)
      offset = scriptLen.next + scriptLen.value
      offset += 4 // sequence
      inputs.push({ prevTxid, prevVout })
    }

    // Outputs
    const outCount = this._readVarInt(data, offset)
    offset = outCount.next
    const outputs = []

    for (let i = 0; i < outCount.value; i++) {
      // Value (8 bytes LE)
      let value = 0n
      for (let j = 0; j < 8; j++) value |= BigInt(data[offset + j]) << BigInt(j * 8)
      offset += 8
      const scriptLen = this._readVarInt(data, offset)
      offset = scriptLen.next
      const script = data.slice(offset, offset + scriptLen.value)
      offset += scriptLen.value
      outputs.push({ value: Number(value), script })
    }

    // Witness data (skip if present)
    if (hasWitness) {
      for (let i = 0; i < inCount.value; i++) {
        const witCount = this._readVarInt(data, offset)
        offset = witCount.next
        for (let j = 0; j < witCount.value; j++) {
          const itemLen = this._readVarInt(data, offset)
          offset = itemLen.next + itemLen.value
        }
      }
    }

    // Locktime (4 bytes)
    offset += 4

    // Compute txid from non-witness serialization
    // For simplicity, use hash of raw bytes (close enough for scanning)
    // TODO: proper txid computation excluding witness
    const txid = this._bytesToHex(data.slice(start, start + 32).reverse()) // placeholder

    return { inputs, outputs, txid: 'scan-' + start, next: offset }
  }
}
