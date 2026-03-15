/**
 * Bitcoin Desktop — main application
 *
 * Orchestrates header sync, Electrum connection, and verification
 */

import { HeaderStore } from './headers.js'
import { BlockFetcher } from './blocks.js'
import { Storage } from './storage.js'
import { DEFAULTS, mergeConfig, computeScore } from './config.js'

const NOSTR_KIND = 33333
const NOSTR_PUBKEY = 'cccccccc829b802b7bf52d43edf7cfe62ac89f332a318b6826ac8bd6e73660da'

export class BitcoinDesktop extends EventTarget {
  constructor(chain = 'btc', userConfig = {}) {
    super()
    this.chain = chain
    this.config = mergeConfig({ chain, ...userConfig })
    this.headers = new HeaderStore(chain)
    this.blocks = new BlockFetcher(this.headers, chain)
    this.blocks.retention = this.config.retention
    this.blocks.rateLimitMs = this.config.rateLimit
    this.blocks.sources = this.config.sources
    this.storage = new Storage(chain)
    this.sockets = {}
    this.nostrTip = 0
    this.status = 'idle'
    this.score = 0
  }

  async start(onProgress) {
    try {
      await this.storage.init()

      // Phase 1: Load cached or download headers from R2
      this.status = 'syncing'
      this.dispatchEvent(new CustomEvent('status', { detail: { phase: 'download', status: 'syncing' } }))

      const cached = await this.storage.loadHeaders()
      const cachedVerified = await this.storage.loadVerified()

      if (cached && cachedVerified) {
        // Use cached headers
        this.headers.headers = cached
        this.headers.height = Math.floor(cached.length / 80) - 1
        this.headers.tipHash = cachedVerified.tipHash
        this.headers.verified = true

        this.dispatchEvent(new CustomEvent('status', {
          detail: { phase: 'download', status: 'cached', height: this.headers.height }
        }))

        // Try to fill gaps incrementally
        try {
          await this._fillGaps(onProgress)
        } catch { /* offline is fine, use cached */ }
      } else {
        // Fresh download — full all.bin
        await this.headers.download((received, total) => {
          if (onProgress) onProgress('download', received, total)
        })
      }

      this.dispatchEvent(new CustomEvent('status', {
        detail: { phase: 'download', status: 'done', height: this.headers.height }
      }))

      // Phase 2: Verify chain (skip if already verified and not updated)
      this.status = 'verifying'
      let result

      if (cached && cachedVerified && this.headers.height === Math.floor(cached.length / 80) - 1) {
        // Headers unchanged, skip re-verification
        result = cachedVerified
        this.dispatchEvent(new CustomEvent('status', { detail: { phase: 'verify', status: 'cached' } }))
      } else {
        this.dispatchEvent(new CustomEvent('status', { detail: { phase: 'verify', status: 'verifying' } }))
        result = await this.headers.verify((done, total, extra) => {
          if (onProgress) onProgress('verify', done, total, extra)
        })

        // Save to cache
        await this.storage.saveHeaders(this.headers.headers)
        await this.storage.saveVerified(result)
      }

      this.dispatchEvent(new CustomEvent('status', {
        detail: { phase: 'verify', status: 'done', ...result }
      }))

      // Phase 3: Bootstrap recent blocks
      if (this.config.retention > 0) {
        this.dispatchEvent(new CustomEvent('status', {
          detail: { phase: 'blocks', status: 'bootstrapping', count: this.config.retention }
        }))
        await this.blocks.bootstrap(this.config.retention)
        this.dispatchEvent(new CustomEvent('status', {
          detail: { phase: 'blocks', status: 'done', cached: this.blocks.cache.size, totalSize: this.blocks.getTotalSize() }
        }))
      }

      // Phase 4: Connect to Nostr for live headers (NIP-333)
      this.dispatchEvent(new CustomEvent('status', { detail: { phase: 'nostr', status: 'connecting' } }))

      let connected = 0
      for (const url of this.config.relays) {
        const ws = new WebSocket(url)
        this.sockets[url] = ws

        ws.onopen = () => {
          connected++
          this.dispatchEvent(new CustomEvent('relay', { detail: { url, status: 'connected', count: connected, total: this.config.relays.length } }))
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
              // Save updated headers
              this.storage.saveHeaders(this.headers.headers).catch(() => {})
              this.storage.saveVerified({
                tipHash: this.headers.tipHash,
                height: this.headers.height,
              }).catch(() => {})

              this.dispatchEvent(new CustomEvent('newblock', {
                detail: { height: this.headers.height, hash: this.headers.tipHash }
              }))

              // Fetch full blocks if retention > 0
              if (this.config.retention !== 0) {
                this._fetchNewBlocks(startHeight + count - appended, this.headers.height)
              }
            }

            this.score = computeScore(this.config, {
              synced: this.headers.height >= tipHeight - 1,
              relaysConnected: connected > 0,
            })

            this.dispatchEvent(new CustomEvent('status', {
              detail: { phase: 'live', height: tipHeight, hash: this.headers.tipHash, score: this.score }
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
  // Fetch and store new blocks (called when new headers arrive)
  async _fetchNewBlocks(fromHeight, toHeight) {
    for (let h = fromHeight; h <= toHeight; h++) {
      try {
        const block = await this.blocks.fetchBlock(h)

        // Save to local storage
        await this.storage.saveBlock(h, block)

        this.dispatchEvent(new CustomEvent('blockfetched', {
          detail: { height: h, size: block.length }
        }))

        // Prune old blocks beyond retention
        if (this.config.retention > 0) {
          const pruneBelow = h - this.config.retention
          if (pruneBelow >= 0) {
            await this.storage.deleteBlock(pruneBelow)
            this.blocks.cache.delete(pruneBelow)
          }
        }
      } catch (err) {
        this.dispatchEvent(new CustomEvent('blockerror', {
          detail: { height: h, error: err.message }
        }))
      }
    }
  }

  // Fill gaps between cached headers and R2 tip
  async _fillGaps(onProgress) {
    const HEADER_SIZE = 80
    const EPOCH_SIZE = 2016
    const R2_BASE = 'https://pub-a5a92731dd0d452b9670be07e5354fd6.r2.dev'
    const cachedHeight = this.headers.height
    const cachedEpoch = Math.floor(cachedHeight / EPOCH_SIZE)

    // First try current.bin — covers gaps within current epoch
    const currentUrl = `${R2_BASE}/${this.chain}/current.bin`
    const currentRes = await fetch(currentUrl)

    if (!currentRes.ok) return // R2 unavailable

    const currentData = new Uint8Array(await currentRes.arrayBuffer())
    const currentCount = currentData.length / HEADER_SIZE

    // Figure out what epoch current.bin represents
    // current.bin starts at some epoch boundary
    // We need to find which headers in it are new to us
    await this.headers.initHasher()

    // Check if first header of current.bin links somewhere in our chain
    const firstPrevHash = this.headers.toHex(this.headers.getPrevHash(currentData.subarray(0, HEADER_SIZE)))

    // Find which height this links to by checking the hash of our cached tip going backwards
    let linkHeight = -1
    for (let h = cachedHeight; h >= Math.max(0, cachedHeight - EPOCH_SIZE); h--) {
      const header = this.headers.getHeader(h)
      if (this.headers.headerHash(header) === firstPrevHash) {
        linkHeight = h
        break
      }
    }

    if (linkHeight >= 0) {
      // current.bin starts at linkHeight + 1
      // We need headers after our cache tip
      const currentStartHeight = linkHeight + 1
      const newStartIndex = cachedHeight - currentStartHeight + 1

      if (newStartIndex >= 0 && newStartIndex < currentCount) {
        const newHeaders = currentData.subarray(newStartIndex * HEADER_SIZE)
        const newCount = newHeaders.length / HEADER_SIZE

        if (newCount > 0) {
          this.dispatchEvent(new CustomEvent('status', {
            detail: { phase: 'download', status: 'updating', height: cachedHeight, remoteHeight: cachedHeight + newCount }
          }))

          // Verify and append
          for (let i = 0; i < newCount; i++) {
            const hex = Array.from(newHeaders.subarray(i * HEADER_SIZE, (i + 1) * HEADER_SIZE))
              .map(b => b.toString(16).padStart(2, '0')).join('')
            try {
              this.headers.appendHeader(hex)
            } catch {
              break // chain break, stop
            }
          }
          return // filled from current.bin
        }
      }
    }

    // Gap is bigger than current epoch — need epoch files
    // Check what R2 has by fetching all.bin size
    const headRes = await fetch(`${R2_BASE}/${this.chain}/all.bin`, { method: 'HEAD' })
    if (!headRes.ok) return

    const remoteSize = parseInt(headRes.headers.get('content-length') || '0')
    const remoteHeight = Math.floor(remoteSize / HEADER_SIZE) - 1

    if (remoteHeight <= cachedHeight) return // nothing new

    const gapBlocks = remoteHeight - cachedHeight

    if (gapBlocks > EPOCH_SIZE * 10) {
      // Gap too large — just re-download all.bin
      this.dispatchEvent(new CustomEvent('status', {
        detail: { phase: 'download', status: 'updating', height: cachedHeight, remoteHeight }
      }))
      await this.headers.download((received, total) => {
        if (onProgress) onProgress('download', received, total)
      })
      return
    }

    // Fetch missing epoch files
    const startEpoch = cachedEpoch + 1
    const endEpoch = Math.floor(remoteHeight / EPOCH_SIZE)

    this.dispatchEvent(new CustomEvent('status', {
      detail: { phase: 'download', status: 'updating', height: cachedHeight, remoteHeight }
    }))

    for (let e = startEpoch; e < endEpoch; e++) {
      const epochUrl = `${R2_BASE}/${this.chain}/epoch/${e}.bin`
      const epochRes = await fetch(epochUrl)
      if (!epochRes.ok) break

      const epochData = new Uint8Array(await epochRes.arrayBuffer())
      const epochCount = epochData.length / HEADER_SIZE

      for (let i = 0; i < epochCount; i++) {
        const hex = Array.from(epochData.subarray(i * HEADER_SIZE, (i + 1) * HEADER_SIZE))
          .map(b => b.toString(16).padStart(2, '0')).join('')
        try {
          this.headers.appendHeader(hex)
        } catch {
          break
        }
      }
    }

    // Finally fetch current.bin again for the remainder
    const currentRes2 = await fetch(currentUrl)
    if (currentRes2.ok) {
      const currentData2 = new Uint8Array(await currentRes2.arrayBuffer())
      const currentCount2 = currentData2.length / HEADER_SIZE
      for (let i = 0; i < currentCount2; i++) {
        const height = Math.floor(this.headers.height / EPOCH_SIZE) * EPOCH_SIZE + i
        if (height <= this.headers.height) continue
        const hex = Array.from(currentData2.subarray(i * HEADER_SIZE, (i + 1) * HEADER_SIZE))
          .map(b => b.toString(16).padStart(2, '0')).join('')
        try {
          this.headers.appendHeader(hex)
        } catch {
          break
        }
      }
    }
  }

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
