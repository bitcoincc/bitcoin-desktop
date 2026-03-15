/**
 * Block fetcher — modular multi-source block downloads with verification
 *
 * Sources are pluggable modules in ./sources/
 * All blocks verified against verified headers before accepting.
 */

import r2Source from './sources/r2.js'
import blockstreamSource from './sources/blockstream.js'
import mempoolSource from './sources/mempool.js'
import p2pSource from './sources/p2p.js'

const HEADER_SIZE = 80
const EPOCH_SIZE = 2016

const ALL_SOURCES = {
  r2: r2Source,
  blockstream: blockstreamSource,
  mempool: mempoolSource,
  p2p: p2pSource,
}

export class BlockFetcher extends EventTarget {
  constructor(headerStore, chain = 'btc') {
    super()
    this.headers = headerStore
    this.chain = chain
    this.cache = new Map()         // height → Uint8Array
    this.retention = 12
    this.rateLimitMs = 200
    this.lastRequest = 0
    this.sourceNames = ['r2', 'blockstream']  // configurable order
    this.isBrowser = typeof window !== 'undefined'
  }

  // Get active source modules (filtered by environment)
  get sources() {
    return this.sourceNames
      .map(name => ALL_SOURCES[name])
      .filter(s => s && (this.isBrowser ? s.browser : s.desktop))
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
    if (block.length < HEADER_SIZE) return false

    const headerBytes = block.subarray(0, HEADER_SIZE)
    const hash = this.headers.headerHash(headerBytes)
    const expectedHash = this.getBlockHash(height)
    if (!expectedHash) return false
    return hash === expectedHash
  }

  // Fetch a block from any source, verify, cache
  async fetchBlock(height) {
    if (this.cache.has(height)) return this.cache.get(height)

    const hash = this.getBlockHash(height)
    if (!hash) throw new Error('No verified header for block ' + height)

    this.dispatchEvent(new CustomEvent('fetching', { detail: { height } }))

    let block = null
    let usedSource = null

    for (const source of this.sources) {
      try {
        await this.throttle()
        block = await source.fetchBlock(height, hash, this.chain)

        if (block) {
          const valid = await this.verifyBlock(height, block)
          if (valid) {
            usedSource = source.name
            this.dispatchEvent(new CustomEvent('fetched', {
              detail: { height, size: block.length, source: source.name }
            }))
            break
          } else {
            this.dispatchEvent(new CustomEvent('rejected', {
              detail: { height, source: source.name, reason: 'hash mismatch' }
            }))
            block = null
          }
        }
      } catch (err) {
        this.dispatchEvent(new CustomEvent('error', {
          detail: { height, source: source.name, error: err.message }
        }))
      }
    }

    if (!block) {
      throw new Error('Could not fetch block ' + height + ' from any source')
    }

    this.cache.set(height, block)
    this.pruneCache()
    return block
  }

  // Bootstrap — fetch last N blocks
  async bootstrap(count) {
    if (!this.headers.headers || this.headers.height < 0) return

    const tipHeight = this.headers.height
    const fromHeight = Math.max(0, tipHeight - count + 1)

    this.dispatchEvent(new CustomEvent('bootstrap', {
      detail: { from: fromHeight, to: tipHeight, count: tipHeight - fromHeight + 1 }
    }))

    for (let h = fromHeight; h <= tipHeight; h++) {
      try {
        await this.fetchBlock(h)
      } catch (err) {
        this.dispatchEvent(new CustomEvent('error', {
          detail: { height: h, source: 'bootstrap', error: err.message }
        }))
      }
    }

    this.dispatchEvent(new CustomEvent('bootstrapped', {
      detail: { cached: this.cache.size, totalSize: this.getTotalSize() }
    }))
  }

  // Prune cache to retention limit
  pruneCache() {
    if (this.retention <= 0 || this.cache.size <= this.retention) return

    const heights = Array.from(this.cache.keys()).sort((a, b) => a - b)
    const toRemove = heights.length - this.retention
    for (let i = 0; i < toRemove; i++) {
      this.cache.delete(heights[i])
      this.dispatchEvent(new CustomEvent('pruned', { detail: { height: heights[i] } }))
    }
  }

  // Total cached size in bytes
  getTotalSize() {
    let total = 0
    for (const block of this.cache.values()) total += block.length
    return total
  }

  // Parse a raw block into header + tx count
  static parseBlock(blockData) {
    const block = new Uint8Array(blockData)
    const header = block.subarray(0, HEADER_SIZE)

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

    return { header, txCount, rawTxOffset: offset, size: block.length }
  }

  getStats() {
    const heights = Array.from(this.cache.keys()).sort((a, b) => a - b)
    return {
      cached: this.cache.size,
      retention: this.retention,
      lowest: heights[0] || null,
      highest: heights[heights.length - 1] || null,
      totalSize: this.getTotalSize(),
      sources: this.sourceNames,
    }
  }
}
