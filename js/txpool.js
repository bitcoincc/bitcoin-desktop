/**
 * Transaction Pool — filtered mempool for wallet transactions
 *
 * Listens for inv(MSG_TX) messages from Bitcoin P2P peers.
 * Filters for transactions matching registered scriptPubkeys.
 * Stores matching unconfirmed txs and notifies subscribers.
 * Removes txs when confirmed in a block.
 *
 * Only stores YOUR transactions — not the full 300MB mempool.
 */

const MSG_TX = 1
const HEADER_SIZE = 80

export class TxPool extends EventTarget {
  constructor(chain = 'btc') {
    super()
    this.chain = chain
    this.enabled = false
    this.filters = new Map()       // scriptPubkey hex → address
    this.pending = new Map()       // txid → { raw, outputs, timestamp }
    this.connection = null         // P2P connection
    this.magic = null
  }

  // Register scriptPubkeys to watch
  watch(address, scriptPubkeyHex) {
    this.filters.set(scriptPubkeyHex, address)
  }

  // Start listening on an existing P2P connection
  async start() {
    if (!this.enabled) return
    if (this.filters.size === 0) return

    const net = require('net')
    const crypto = require('crypto')

    const MAGIC = {
      btc: Buffer.from('f9beb4d9', 'hex'),
      tbtc4: Buffer.from('1c163f28', 'hex'),
    }
    this.magic = MAGIC[this.chain] || MAGIC.btc

    const SEEDS = {
      btc: ['seed.bitcoin.sipa.be'],
      tbtc4: ['seed.testnet4.bitcoin.sprovoost.nl'],
    }
    const seeds = SEEDS[this.chain] || SEEDS.btc
    const port = this.chain === 'tbtc4' ? 48333 : 8333

    // Resolve a peer
    const dns = require('dns').promises
    let peerIp
    for (const seed of seeds) {
      try {
        const ips = await dns.resolve4(seed)
        if (ips.length > 0) { peerIp = ips[Math.floor(Math.random() * ips.length)]; break }
      } catch {}
    }
    if (!peerIp) { console.log('[txpool] no peers found'); return }

    // Connect
    console.log(`[txpool] connecting to ${peerIp}:${port}`)
    const sock = net.createConnection(port, peerIp)
    this.connection = sock

    let buffer = Buffer.alloc(0)
    let handshaked = false

    const sha256d = (data) => {
      const h1 = crypto.createHash('sha256').update(data).digest()
      return crypto.createHash('sha256').update(h1).digest()
    }

    const buildMsg = (cmd, payload) => {
      const h = Buffer.alloc(24)
      this.magic.copy(h)
      const c = Buffer.alloc(12); c.write(cmd, 'ascii'); c.copy(h, 4)
      h.writeUInt32LE(payload.length, 16)
      sha256d(payload).copy(h, 20, 0, 4)
      return Buffer.concat([h, payload])
    }

    const buildVersion = () => {
      const ua = '/bitcoin-desktop:0.0.1/'
      const v = Buffer.alloc(4 + 8 + 8 + 26 + 26 + 8 + 1 + ua.length + 4 + 1)
      let o = 0
      v.writeInt32LE(70016, o); o += 4
      v.writeBigUInt64LE(0n, o); o += 8 // NODE_NONE — we just want txs
      v.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), o); o += 8
      o += 26 + 26 // addr_recv + addr_from
      crypto.randomBytes(8).copy(v, o); o += 8
      v.writeUInt8(ua.length, o); o += 1
      v.write(ua, o, 'ascii'); o += ua.length
      v.writeInt32LE(0, o); o += 4
      v.writeUInt8(1, o); o += 1 // relay=true — we want tx announcements
      return v.subarray(0, o)
    }

    sock.on('connect', () => {
      sock.write(buildMsg('version', buildVersion()))
    })

    sock.on('data', (data) => {
      buffer = Buffer.concat([buffer, data])

      while (buffer.length >= 24) {
        if (!buffer.subarray(0, 4).equals(this.magic)) {
          const idx = buffer.indexOf(this.magic, 1)
          if (idx === -1) { buffer = Buffer.alloc(0); return }
          buffer = buffer.subarray(idx)
          continue
        }

        const cmd = buffer.subarray(4, 16).toString('ascii').replace(/\0/g, '')
        const len = buffer.readUInt32LE(16)
        if (buffer.length < 24 + len) return

        const payload = buffer.subarray(24, 24 + len)
        buffer = buffer.subarray(24 + len)

        if (cmd === 'version') {
          sock.write(buildMsg('verack', Buffer.alloc(0)))
        } else if (cmd === 'verack') {
          handshaked = true
          console.log('[txpool] connected, listening for transactions')
          this.dispatchEvent(new CustomEvent('connected'))
        } else if (cmd === 'inv') {
          this._handleInv(payload, sock, buildMsg)
        } else if (cmd === 'tx') {
          this._handleTx(payload, sha256d)
        } else if (cmd === 'ping') {
          sock.write(buildMsg('pong', payload))
        }
      }
    })

    sock.on('error', (err) => {
      console.log('[txpool] error:', err.message)
    })

    sock.on('close', () => {
      console.log('[txpool] disconnected')
      // Reconnect after delay
      if (this.enabled) {
        setTimeout(() => this.start(), 10000)
      }
    })
  }

  _handleInv(payload, sock, buildMsg) {
    let offset = 0
    const count = payload[offset]; offset++
    if (count === 0xfd) { offset += 2 } // skip extended varint for now

    const txRequests = []
    for (let i = 0; i < count && offset + 36 <= payload.length; i++) {
      const type = payload.readUInt32LE(offset); offset += 4
      const hash = payload.subarray(offset, offset + 32); offset += 32

      if (type === MSG_TX) {
        txRequests.push(hash)
      }
    }

    // Request all announced txs (we filter after receiving)
    // For efficiency, could batch — but for personal wallet traffic is tiny
    if (txRequests.length > 0) {
      const getdata = Buffer.alloc(1 + txRequests.length * 36)
      getdata.writeUInt8(txRequests.length, 0)
      let off = 1
      for (const hash of txRequests) {
        getdata.writeUInt32LE(MSG_TX, off); off += 4
        hash.copy(getdata, off); off += 32
      }
      sock.write(buildMsg('getdata', getdata))
    }
  }

  _handleTx(payload, sha256d) {
    // Compute txid
    // For witness txs, txid excludes witness — but for filtering outputs
    // we just need to parse outputs and check scriptPubkeys
    const txid = Buffer.from(sha256d(payload)).reverse().toString('hex')

    // Parse outputs to check for matches
    let offset = 4 // skip version

    // Check segwit marker
    let hasWitness = false
    if (payload[offset] === 0x00 && payload[offset + 1] !== 0x00) {
      hasWitness = true
      offset += 2
    }

    // Skip inputs
    let inCount = payload[offset]; offset++
    for (let i = 0; i < inCount; i++) {
      offset += 36 // prevhash + previndex
      let scriptLen = payload[offset]; offset++
      offset += scriptLen + 4 // script + sequence
    }

    // Parse outputs
    let outCount = payload[offset]; offset++
    const matchingOutputs = []

    for (let i = 0; i < outCount; i++) {
      const value = Number(payload.readBigUInt64LE(offset)); offset += 8
      const scriptLen = payload[offset]; offset++
      const script = payload.subarray(offset, offset + scriptLen)
      offset += scriptLen

      const scriptHex = script.toString('hex')
      if (this.filters.has(scriptHex)) {
        const address = this.filters.get(scriptHex)
        matchingOutputs.push({ vout: i, value, address, scriptHex })
      }
    }

    if (matchingOutputs.length > 0) {
      const entry = {
        txid,
        outputs: matchingOutputs,
        timestamp: Date.now(),
        confirmed: false,
      }
      this.pending.set(txid, entry)

      console.log(`[txpool] match! ${txid} → ${matchingOutputs.map(o => o.value + ' sats to ' + o.address).join(', ')}`)

      this.dispatchEvent(new CustomEvent('tx', { detail: entry }))
    }
  }

  // Called when a block is confirmed — remove matching txs from pending
  confirmBlock(blockTxids) {
    for (const txid of blockTxids) {
      if (this.pending.has(txid)) {
        const entry = this.pending.get(txid)
        entry.confirmed = true
        this.pending.delete(txid)
        this.dispatchEvent(new CustomEvent('confirmed', { detail: entry }))
      }
    }
  }

  stop() {
    this.enabled = false
    if (this.connection) {
      this.connection.destroy()
      this.connection = null
    }
  }

  getPending() {
    return Array.from(this.pending.values())
  }
}
