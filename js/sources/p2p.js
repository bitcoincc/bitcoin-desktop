/**
 * Bitcoin P2P network block source (desktop only)
 * Connects directly to Bitcoin nodes via TCP port 8333
 * No rate limits, no API keys, the authoritative source
 */

const MAGIC = {
  btc: Buffer.from('f9beb4d9', 'hex'),
  tbtc4: Buffer.from('1c163f28', 'hex'),  // testnet4
}

const SEEDS = {
  btc: [
    'seed.bitcoin.sipa.be',
    'dnsseed.bluematt.me',
    'dnsseed.bitcoin.dashjr-list-of-p2p-nodes.us',
    'seed.bitcoinstats.com',
    'seed.bitcoin.jonasschnelli.ch',
  ],
  tbtc4: [
    'seed.testnet4.bitcoin.sprovoost.nl',
  ],
}

const PROTOCOL_VERSION = 70016
const USER_AGENT = '/bitcoin-desktop:0.0.1/'
const MSG_BLOCK = 2

function sha256d(data) {
  const crypto = require('crypto')
  const h1 = crypto.createHash('sha256').update(data).digest()
  return crypto.createHash('sha256').update(h1).digest()
}

function buildMessage(magic, command, payload) {
  const header = Buffer.alloc(24)
  magic.copy(header, 0)

  // Command — 12 bytes, null-padded ASCII
  const cmdBuf = Buffer.alloc(12)
  cmdBuf.write(command, 'ascii')
  cmdBuf.copy(header, 4)

  // Payload length
  header.writeUInt32LE(payload.length, 16)

  // Checksum — first 4 bytes of sha256d(payload)
  const checksum = sha256d(payload)
  checksum.copy(header, 20, 0, 4)

  return Buffer.concat([header, payload])
}

function buildVersionMessage(chain) {
  const payload = Buffer.alloc(85 + USER_AGENT.length + 1)
  let offset = 0

  // version (int32_t LE)
  payload.writeInt32LE(PROTOCOL_VERSION, offset); offset += 4
  // services (uint64_t LE) — NODE_NONE
  payload.writeBigUInt64LE(0n, offset); offset += 8
  // timestamp (int64_t LE)
  payload.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), offset); offset += 8
  // addr_recv — 26 bytes (services 8 + ip 16 + port 2)
  offset += 26
  // addr_from — 26 bytes
  offset += 26
  // nonce (uint64_t LE)
  payload.writeBigUInt64LE(BigInt(Math.floor(Math.random() * 0xFFFFFFFF)), offset); offset += 8
  // user_agent (var_str)
  payload.writeUInt8(USER_AGENT.length, offset); offset += 1
  payload.write(USER_AGENT, offset, 'ascii'); offset += USER_AGENT.length
  // start_height (int32_t LE)
  payload.writeInt32LE(0, offset); offset += 4
  // relay (bool)
  payload.writeUInt8(0, offset); offset += 1

  return payload.subarray(0, offset)
}

function buildGetdataMessage(blockHash) {
  // count = 1
  const payload = Buffer.alloc(1 + 4 + 32)
  payload.writeUInt8(1, 0)
  // type = MSG_BLOCK (2)
  payload.writeUInt32LE(MSG_BLOCK, 1)
  // hash — 32 bytes, internal byte order (reversed from display)
  const hashBytes = Buffer.from(blockHash, 'hex').reverse()
  hashBytes.copy(payload, 5)
  return payload
}

class P2PConnection {
  constructor(host, port, magic) {
    this.host = host
    this.port = port
    this.magic = magic
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.handshaked = false
    this.onBlock = null
    this._resolve = null
  }

  connect() {
    const net = require('net')
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.socket) this.socket.destroy()
        reject(new Error('Connection timeout'))
      }, 10000)

      this.socket = net.createConnection(this.port, this.host, () => {
        clearTimeout(timeout)
        // Send version
        const versionPayload = buildVersionMessage()
        this.socket.write(buildMessage(this.magic, 'version', versionPayload))
        resolve()
      })

      this.socket.on('data', (data) => this._onData(data))
      this.socket.on('error', (err) => {
        clearTimeout(timeout)
        if (!this.handshaked) reject(err)
      })
    })
  }

  _onData(data) {
    this.buffer = Buffer.concat([this.buffer, data])
    this._processMessages()
  }

  _processMessages() {
    while (this.buffer.length >= 24) {
      // Check magic
      if (!this.buffer.subarray(0, 4).equals(this.magic)) {
        // Scan for magic
        const idx = this.buffer.indexOf(this.magic, 1)
        if (idx === -1) { this.buffer = Buffer.alloc(0); return }
        this.buffer = this.buffer.subarray(idx)
        continue
      }

      // Read header
      const command = this.buffer.subarray(4, 16).toString('ascii').replace(/\0/g, '')
      const payloadLen = this.buffer.readUInt32LE(16)
      const totalLen = 24 + payloadLen

      // Wait for full message
      if (this.buffer.length < totalLen) return

      const payload = this.buffer.subarray(24, totalLen)
      this.buffer = this.buffer.subarray(totalLen)

      this._handleMessage(command, payload)
    }
  }

  _handleMessage(command, payload) {
    if (command === 'version') {
      // Send verack
      this.socket.write(buildMessage(this.magic, 'verack', Buffer.alloc(0)))
    } else if (command === 'verack') {
      this.handshaked = true
      console.log('[p2p] handshake complete with', this.host)
    } else if (command === 'block') {
      console.log('[p2p] received block:', payload.length, 'bytes')
      if (this._resolve) {
        this._resolve(new Uint8Array(payload))
        this._resolve = null
      }
    } else if (command === 'ping') {
      // Reply with pong
      this.socket.write(buildMessage(this.magic, 'pong', payload))
    }
  }

  async requestBlock(blockHash) {
    if (!this.handshaked) {
      // Wait for handshake
      await new Promise(resolve => {
        const check = setInterval(() => {
          if (this.handshaked) { clearInterval(check); resolve() }
        }, 100)
        setTimeout(() => { clearInterval(check); resolve() }, 5000)
      })
    }

    if (!this.handshaked) throw new Error('Handshake failed')

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._resolve = null
        reject(new Error('Block request timeout'))
      }, 10000)

      this._resolve = (block) => {
        clearTimeout(timeout)
        resolve(block)
      }

      const getdata = buildGetdataMessage(blockHash)
      this.socket.write(buildMessage(this.magic, 'getdata', getdata))
    })
  }

  close() {
    if (this.socket) this.socket.destroy()
  }
}

// Resolve DNS seed to peer IPs
async function resolveSeed(seed) {
  const dns = require('dns').promises
  try {
    const addresses = await dns.resolve4(seed)
    return addresses.slice(0, 3) // take first 3
  } catch {
    return []
  }
}

export default {
  name: 'p2p',
  label: 'Bitcoin P2P Network',
  browser: false,
  desktop: true,
  _connection: null,

  async fetchBlock(height, hash, chain) {
    if (typeof require === 'undefined') return null // browser

    const magic = MAGIC[chain] || MAGIC.btc
    const seeds = SEEDS[chain] || SEEDS.btc

    try {
      // Reuse existing connection if alive
      if (this._connection && this._connection.handshaked) {
        try {
          return await this._connection.requestBlock(hash)
        } catch {
          this._connection.close()
          this._connection = null
        }
      }

      // Find a peer
      for (const seed of seeds) {
        const ips = await resolveSeed(seed)
        for (const ip of ips) {
          const port = chain === 'tbtc4' ? 48333 : 8333
          const conn = new P2PConnection(ip, port, magic)
          try {
            await conn.connect()
            const block = await conn.requestBlock(hash)
            this._connection = conn // keep alive for next request
            return block
          } catch (err) {
            console.log('[p2p] peer', ip, 'failed:', err.message)
            conn.close()
          }
        }
      }

      return null
    } catch (err) {
      console.log('[p2p] error:', err.message)
      return null
    }
  }
}
