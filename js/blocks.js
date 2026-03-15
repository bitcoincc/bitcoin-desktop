/**
 * Block fetcher — multi-source block downloads with verification
 *
 * Sources (in priority order):
 *   1. R2 CDN (our own, no limits)
 *   2. Blockstream.info API (free, cacheable)
 *   3. Bitcoin P2P network (desktop only, raw protocol)
 *
 * All blocks verified against verified headers before accepting.
 */

const R2_BASE = 'https://pub-a5a92731dd0d452b9670be07e5354fd6.r2.dev'
const BLOCKSTREAM_API = 'https://blockstream.info/api'
const HEADER_SIZE = 80
const EPOCH_SIZE = 2016

export class BlockFetcher extends EventTarget {
  constructor(headerStore, chain = 'btc') {
    super()
    this.headers = headerStore
    this.chain = chain
    this.cache = new Map()         // height → Uint8Array
    this.retention = 5000          // max blocks to keep
    this.rateLimitMs = 200         // min ms between API requests
    this.lastRequest = 0
    this.sources = ['r2', 'blockstream']  // configurable
  }

  // Rate limiter
  async throttle() {
    const now = Date.now()
    const wait = this.rateLimitMs - (now - this.lastRequest)
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    this.lastRequest = Date.now()
  }

  // Get block hash from verified headers
  getBlockHash(height) {
    if (!this.headers.headers || height > this.headers.height) return null
    const header = this.headers.getHeader(height)
    if (!header) return null
    return this.headers.headerHash(header)
  }

  // Verify a raw block against our verified headers
  async verifyBlock(height, blockData) {
    await this.headers.initHasher()
    const block = new Uint8Array(blockData)

    // Block must be at least 80 bytes (header)
    if (block.length < HEADER_SIZE) return false

    // Hash the header portion
    const headerBytes = block.subarray(0, HEADER_SIZE)
    const hash = this.headers.headerHash(headerBytes)
    const expectedHash = this.getBlockHash(height)

    if (!expectedHash) return false
    return hash === expectedHash
  }

  // Fetch from R2 CDN
  async fetchFromR2(height) {
    const epoch = Math.floor(height / EPOCH_SIZE)
    const url = `${R2_BASE}/${this.chain}/blocks/${epoch}/${height}.bin`
    try {
      const res = await fetch(url)
      if (!res.ok) return null
      return new Uint8Array(await res.arrayBuffer())
    } catch {
      return null
    }
  }

  // Fetch from Blockstream.info
  async fetchFromBlockstream(height) {
    const hash = this.getBlockHash(height)
    if (!hash) return null

    const api = this.chain === 'tbtc4'
      ? 'https://mempool.space/testnet4/api'
      : BLOCKSTREAM_API

    await this.throttle()
    try {
      const res = await fetch(`${api}/block/${hash}/raw`)
      if (!res.ok) return null
      return new Uint8Array(await res.arrayBuffer())
    } catch {
      return null
    }
  }

  // Fetch a block from any source, verify, cache
  async fetchBlock(height) {
    // Check cache first
    if (this.cache.has(height)) return this.cache.get(height)

    this.dispatchEvent(new CustomEvent('fetching', { detail: { height } }))

    let block = null

    for (const source of this.sources) {
      try {
        if (source === 'r2') {
          block = await this.fetchFromR2(height)
        } else if (source === 'blockstream') {
          block = await this.fetchFromBlockstream(height)
        }

        if (block) {
          // Verify against headers
          const valid = await this.verifyBlock(height, block)
          if (valid) {
            this.dispatchEvent(new CustomEvent('fetched', {
              detail: { height, size: block.length, source }
            }))
            break
          } else {
            this.dispatchEvent(new CustomEvent('rejected', {
              detail: { height, source, reason: 'hash mismatch' }
            }))
            block = null
          }
        }
      } catch (err) {
        this.dispatchEvent(new CustomEvent('error', {
          detail: { height, source, error: err.message }
        }))
      }
    }

    if (!block) {
      throw new Error('Could not fetch block ' + height + ' from any source')
    }

    // Cache and prune
    this.cache.set(height, block)
    this.pruneCache()

    return block
  }

  // Fetch a range of blocks
  async fetchRange(fromHeight, toHeight) {
    const blocks = []
    for (let h = fromHeight; h <= toHeight; h++) {
      const block = await this.fetchBlock(h)
      blocks.push({ height: h, data: block })
    }
    return blocks
  }

  // Prune cache to retention limit
  pruneCache() {
    if (this.cache.size <= this.retention) return

    // Remove oldest blocks first
    const heights = Array.from(this.cache.keys()).sort((a, b) => a - b)
    const toRemove = heights.length - this.retention
    for (let i = 0; i < toRemove; i++) {
      this.cache.delete(heights[i])
      this.dispatchEvent(new CustomEvent('pruned', { detail: { height: heights[i] } }))
    }
  }

  // Parse a raw block into header + transactions
  static parseBlock(blockData) {
    const block = new Uint8Array(blockData)
    const header = block.subarray(0, HEADER_SIZE)

    // Read varint for tx count
    let offset = HEADER_SIZE
    let txCount = 0
    const firstByte = block[offset]

    if (firstByte < 0xfd) {
      txCount = firstByte
      offset += 1
    } else if (firstByte === 0xfd) {
      txCount = block[offset + 1] | (block[offset + 2] << 8)
      offset += 3
    } else if (firstByte === 0xfe) {
      txCount = block[offset + 1] | (block[offset + 2] << 8) | (block[offset + 3] << 16) | (block[offset + 4] << 24)
      offset += 5
    }

    return {
      header,
      txCount,
      rawTxOffset: offset,
      size: block.length,
    }
  }

  // Get stats
  getStats() {
    const heights = Array.from(this.cache.keys()).sort((a, b) => a - b)
    const totalSize = Array.from(this.cache.values()).reduce((s, b) => s + b.length, 0)
    return {
      cached: this.cache.size,
      retention: this.retention,
      lowest: heights[0] || null,
      highest: heights[heights.length - 1] || null,
      totalSize,
      sources: this.sources,
    }
  }
}
