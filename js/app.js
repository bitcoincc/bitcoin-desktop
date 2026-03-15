/**
 * Bitcoin Desktop — main application
 *
 * Orchestrates header sync, Electrum connection, and verification
 */

import { ElectrumClient } from './electrum.js'
import { HeaderStore } from './headers.js'

export class BitcoinDesktop extends EventTarget {
  constructor(chain = 'btc') {
    super()
    this.chain = chain
    this.headers = new HeaderStore(chain)
    this.electrum = new ElectrumClient(chain)
    this.status = 'idle' // idle, syncing, verifying, ready, error
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

      const result = await this.headers.verify((done, total) => {
        if (onProgress) onProgress('verify', done, total)
      })

      this.dispatchEvent(new CustomEvent('status', {
        detail: { phase: 'verify', status: 'done', ...result }
      }))

      // Phase 3: Connect to Electrum for live updates
      this.dispatchEvent(new CustomEvent('status', { detail: { phase: 'electrum', status: 'connecting' } }))

      this.electrum.addEventListener('header', (e) => {
        const header = e.detail
        if (header.height > this.headers.height) {
          try {
            this.headers.appendHeader(header.hex)
            this.dispatchEvent(new CustomEvent('newblock', {
              detail: { height: this.headers.height, hash: this.headers.tipHash }
            }))
          } catch (err) {
            console.error('Failed to append header:', err.message)
          }
        }
      })

      await this.electrum.connect()
      await this.electrum.call('blockchain.headers.subscribe', [])

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
