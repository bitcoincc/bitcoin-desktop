/**
 * Bitcoin Desktop — main application
 *
 * Orchestrates header sync, Electrum connection, and verification
 */

import { HeaderStore } from './headers.js'

const NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.net',
  'wss://relay.primal.net',
]
const NOSTR_KIND = 33333
const NOSTR_PUBKEY = 'cccccccc829b802b7bf52d43edf7cfe62ac89f332a318b6826ac8bd6e73660da'

export class BitcoinDesktop extends EventTarget {
  constructor(chain = 'btc') {
    super()
    this.chain = chain
    this.headers = new HeaderStore(chain)
    this.sockets = {}
    this.nostrTip = 0
    this.status = 'idle'
  }

  async start(onProgress) {
    try {
      // Phase 1: Download headers from R2
      this.status = 'syncing'
      this.dispatchEvent(new CustomEvent('status', { detail: { phase: 'download', status: 'syncing' } }))

      await this.headers.download((received, total) => {
        if (onProgress) onProgress('download', received, total)
      })

      this.dispatchEvent(new CustomEvent('status', {
        detail: { phase: 'download', status: 'done', height: this.headers.height }
      }))

      // Phase 2: Verify chain
      this.status = 'verifying'
      this.dispatchEvent(new CustomEvent('status', { detail: { phase: 'verify', status: 'verifying' } }))

      const result = await this.headers.verify((done, total, extra) => {
        if (onProgress) onProgress('verify', done, total, extra)
      })

      this.dispatchEvent(new CustomEvent('status', {
        detail: { phase: 'verify', status: 'done', ...result }
      }))

      // Phase 3: Connect to Nostr for live headers (NIP-333)
      this.dispatchEvent(new CustomEvent('status', { detail: { phase: 'nostr', status: 'connecting' } }))

      let connected = 0
      for (const url of NOSTR_RELAYS) {
        const ws = new WebSocket(url)
        this.sockets[url] = ws

        ws.onopen = () => {
          connected++
          this.dispatchEvent(new CustomEvent('relay', { detail: { url, status: 'connected', count: connected, total: NOSTR_RELAYS.length } }))
          ws.send(JSON.stringify([
            'REQ', 'headers',
            { kinds: [NOSTR_KIND], authors: [NOSTR_PUBKEY], '#d': ['latest'], '#n': [this.chain], limit: 1 }
          ]))
        }

        ws.onmessage = async (e) => {
          try {
            const msg = JSON.parse(e.data)
            if (msg[0] !== 'EVENT' || msg[2]?.kind !== NOSTR_KIND) return

            const event = msg[2]
            const tags = Object.fromEntries(event.tags)
            const tipHeight = parseInt(tags.tip, 10)
            if (tipHeight <= this.nostrTip) return
            this.nostrTip = tipHeight

            // Parse headers from event
            const count = event.content.length / 160
            const startHeight = tipHeight - count + 1

            // Try to append new headers
            await this.headers.initHasher()
            let appended = 0
            for (let i = 0; i < count; i++) {
              const height = startHeight + i
              if (height <= this.headers.height) continue
              if (height !== this.headers.height + 1) break // gap
              const hex = event.content.slice(i * 160, (i + 1) * 160)
              try {
                this.headers.appendHeader(hex)
                appended++
              } catch { break }
            }

            if (appended > 0) {
              this.dispatchEvent(new CustomEvent('newblock', {
                detail: { height: this.headers.height, hash: this.headers.tipHash }
              }))
            }

            this.dispatchEvent(new CustomEvent('status', {
              detail: { phase: 'live', height: tipHeight, hash: this.headers.tipHash }
            }))
          } catch (err) {
            console.error('Nostr parse error:', err)
          }
        }

        ws.onclose = () => {
          connected = Math.max(0, connected - 1)
          // Reconnect
          setTimeout(() => {
            if (this.sockets[url]) {
              const newWs = new WebSocket(url)
              newWs.onopen = ws.onopen
              newWs.onmessage = ws.onmessage
              newWs.onclose = ws.onclose
              this.sockets[url] = newWs
            }
          }, 5000)
        }
      }

      this.status = 'ready'
      this.dispatchEvent(new CustomEvent('status', {
        detail: { phase: 'ready', height: this.headers.height, tipHash: this.headers.tipHash }
      }))

    } catch (err) {
      this.status = 'error'
      this.dispatchEvent(new CustomEvent('status', {
        detail: { phase: 'error', error: err.message }
      }))
      throw err
    }
  }

  // Verify a transaction by txid
  async verifyTransaction(txid) {
    const API = this.chain === 'btc'
      ? 'https://mempool.space/api'
      : 'https://mempool.space/testnet4/api'

    // Fetch merkle proof
    const proofRes = await fetch(`${API}/tx/${txid}/merkle-proof`)
    if (!proofRes.ok) throw new Error('Transaction not found')
    const proof = await proofRes.json()

    // Get header
    const header = this.headers.getHeader(proof.block_height)
    if (!header) throw new Error('Block not in header archive')

    // Verify merkle proof
    await this.headers.initHasher()

    const hexToBytes = hex => {
      const b = new Uint8Array(hex.length / 2)
      for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.substr(i, 2), 16)
      return b
    }

    const reverseBytes = bytes => {
      const r = new Uint8Array(bytes.length)
      for (let i = 0; i < bytes.length; i++) r[i] = bytes[bytes.length - 1 - i]
      return r
    }

    let current = reverseBytes(hexToBytes(txid))

    for (let i = 0; i < proof.merkle.length; i++) {
      const sibling = reverseBytes(hexToBytes(proof.merkle[i]))
      const isRight = (proof.pos >> i) & 1
      const combined = new Uint8Array(64)

      if (isRight) {
        combined.set(sibling, 0)
        combined.set(current, 32)
      } else {
        combined.set(current, 0)
        combined.set(sibling, 32)
      }

      current = this.headers.hash256(combined)
    }

    const computedRoot = this.headers.toHex(reverseBytes(current))
    const expectedRoot = this.headers.toHex(reverseBytes(header.slice(36, 68)))

    const match = computedRoot === expectedRoot
    const confirmations = this.headers.height - proof.block_height + 1

    return {
      verified: match,
      blockHeight: proof.block_height,
      confirmations,
      proofDepth: proof.merkle.length,
      timestamp: this.headers.getTimestamp(header),
    }
  }
}
