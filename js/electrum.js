/**
 * Electrum client — works in browser (WebSocket) and Node.js (TCP/SSL)
 *
 * Usage:
 *   const client = new ElectrumClient(chain)
 *   await client.connect()
 *   const tip = await client.call('blockchain.headers.subscribe', [])
 *   client.on('header', header => console.log('new block!', header))
 */

const SERVERS = {
  btc: {
    wss: [
      'wss://blockstream.info/electrum-websocket/',
      'wss://mempool.guide/electrum-websocket/',
    ],
    tcp: [
      { host: 'electrum.blockstream.info', port: 50002 },
      { host: 'electrum.jochen-hoenicke.de', port: 50006 },
      { host: 'e-x.not.fyi', port: 50002 },
    ]
  },
  tbtc4: {
    wss: [
      // TODO: find testnet4 WebSocket Electrum servers
    ],
    tcp: [
      { host: 'mempool.space', port: 40002 },
    ]
  }
}

export class ElectrumClient extends EventTarget {
  constructor(chain = 'btc') {
    super()
    this.chain = chain
    this.servers = SERVERS[chain] || SERVERS.btc
    this.socket = null
    this.requestId = 0
    this.pending = new Map()
    this.buffer = ''
    this.connected = false
    this.serverIndex = 0
  }

  async connect() {
    // Browser: use WebSocket
    if (typeof window !== 'undefined' && this.servers.wss.length > 0) {
      return this._connectWS()
    }
    // Node.js: use TCP/SSL
    if (this.servers.tcp.length > 0) {
      return this._connectTCP()
    }
    throw new Error('No servers available for chain: ' + this.chain)
  }

  _connectWS() {
    return new Promise((resolve, reject) => {
      const url = this.servers.wss[this.serverIndex % this.servers.wss.length]
      this.socket = new WebSocket(url)

      this.socket.onopen = () => {
        this.connected = true
        this.dispatchEvent(new CustomEvent('connected', { detail: { url } }))
        resolve()
      }

      this.socket.onmessage = (e) => {
        this._onData(e.data)
      }

      this.socket.onclose = () => {
        this.connected = false
        this.dispatchEvent(new CustomEvent('disconnected'))
      }

      this.socket.onerror = () => {
        if (!this.connected) reject(new Error('WebSocket connection failed: ' + url))
      }
    })
  }

  async _connectTCP() {
    const tls = await import('tls')
    const server = this.servers.tcp[this.serverIndex % this.servers.tcp.length]

    return new Promise((resolve, reject) => {
      this.socket = tls.connect({
        host: server.host,
        port: server.port,
        rejectUnauthorized: false,
      })

      this.socket.on('connect', () => {
        this.connected = true
        this.dispatchEvent(new CustomEvent('connected', { detail: server }))
        resolve()
      })

      this.socket.on('data', (data) => {
        this._onData(data.toString())
      })

      this.socket.on('close', () => {
        this.connected = false
        this.dispatchEvent(new CustomEvent('disconnected'))
      })

      this.socket.on('error', (err) => {
        if (!this.connected) reject(err)
      })
    })
  }

  _onData(data) {
    this.buffer += data
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop()

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)

        // Subscription notification
        if (msg.method === 'blockchain.headers.subscribe') {
          this.dispatchEvent(new CustomEvent('header', { detail: msg.params[0] }))
          return
        }
        if (msg.method === 'blockchain.scripthash.subscribe') {
          this.dispatchEvent(new CustomEvent('scripthash', { detail: { scripthash: msg.params[0], status: msg.params[1] } }))
          return
        }

        // RPC response
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject, timeout } = this.pending.get(msg.id)
          clearTimeout(timeout)
          this.pending.delete(msg.id)
          if (msg.error) reject(new Error(msg.error.message))
          else resolve(msg.result)
        }
      } catch (e) { /* ignore parse errors */ }
    }
  }

  call(method, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('Not connected'))

      const id = ++this.requestId
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Timeout: ' + method))
      }, 30000)

      this.pending.set(id, { resolve, reject, timeout })

      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
      if (this.socket.send) {
        this.socket.send(msg) // WebSocket
      } else {
        this.socket.write(msg) // TCP
      }
    })
  }

  close() {
    this.connected = false
    if (this.socket) {
      if (this.socket.close) this.socket.close() // WebSocket
      else if (this.socket.destroy) this.socket.destroy() // TCP
    }
  }
}
