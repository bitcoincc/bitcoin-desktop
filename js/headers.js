/**
 * Header store — download, verify, and manage Bitcoin block headers
 *
 * Storage: IndexedDB (browser) or filesystem (Node/Electron)
 * Source: R2 CDN for bulk, Electrum for live
 */

const HEADER_SIZE = 80
const EPOCH_SIZE = 2016

const R2_BASE = 'https://pub-a5a92731dd0d452b9670be07e5354fd6.r2.dev'

const GENESIS_HASHES = {
  btc: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
  tbtc4: '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043',
}

export class HeaderStore extends EventTarget {
  constructor(chain = 'btc') {
    super()
    this.chain = chain
    this.headers = null     // Uint8Array of all headers
    this.height = -1
    this.tipHash = ''
    this.verified = false
    this.hasher = null
  }

  async initHasher() {
    if (this.hasher) return
    const { createSHA256 } = await import('https://esm.sh/hash-wasm@4')
    this.hasher = await createSHA256()
  }

  hash256(uint8arr) {
    this.hasher.init()
    this.hasher.update(uint8arr)
    const h1 = this.hasher.digest('binary')
    this.hasher.init()
    this.hasher.update(h1)
    return this.hasher.digest('binary')
  }

  headerHash(header) {
    const h = this.hash256(header)
    const r = new Uint8Array(32)
    for (let i = 0; i < 32; i++) r[i] = h[31 - i]
    return this.toHex(r)
  }

  getPrevHash(header) {
    const r = new Uint8Array(32)
    for (let i = 0; i < 32; i++) r[i] = header[35 - i]
    return r
  }

  getTimestamp(header) {
    return new DataView(header.buffer, header.byteOffset).getUint32(68, true)
  }

  getBits(header) {
    return new DataView(header.buffer, header.byteOffset).getUint32(72, true)
  }

  toHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  // Download headers from R2
  async download(onProgress) {
    await this.initHasher()
    const url = `${R2_BASE}/${this.chain}/all.bin`

    const res = await fetch(url)
    if (!res.ok) throw new Error('Failed to fetch headers: ' + res.status)

    const contentLength = parseInt(res.headers.get('content-length') || '0')
    const reader = res.body.getReader()
    const chunks = []
    let received = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.length
      if (onProgress) onProgress(received, contentLength)
    }

    this.headers = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
      this.headers.set(chunk, offset)
      offset += chunk.length
    }

    this.height = Math.floor(this.headers.length / HEADER_SIZE) - 1
    return this.height
  }

  // Verify chain — returns { passed, errors, work, elapsed }
  async verify(onProgress) {
    if (!this.headers) throw new Error('No headers loaded')
    await this.initHasher()

    const total = this.height + 1
    const genesisHash = GENESIS_HASHES[this.chain]
    let prevHash = null
    let totalWork = 0n
    let errors = 0
    const TWO_256 = 2n ** 256n
    const BATCH = 2000
    const start = performance.now()

    for (let i = 0; i < total; i += BATCH) {
      const end = Math.min(i + BATCH, total)

      for (let j = i; j < end; j++) {
        const header = this.headers.subarray(j * HEADER_SIZE, (j + 1) * HEADER_SIZE)
        const h = this.hash256(header)
        const hr = new Uint8Array(32)
        for (let k = 0; k < 32; k++) hr[k] = h[31 - k]

        // Genesis check
        if (j === 0 && genesisHash && this.toHex(hr) !== genesisHash) {
          errors++
        }

        // Chain linkage
        if (prevHash) {
          const ph = this.getPrevHash(header)
          for (let k = 0; k < 32; k++) {
            if (prevHash[k] !== ph[k]) { errors++; break }
          }
        }

        // Accumulate work
        const bits = this.getBits(header)
        const exp = bits >> 24
        const man = BigInt(bits & 0x7fffff)
        if (man > 0n) {
          const target = man * (2n ** BigInt(8 * (exp - 3)))
          totalWork += TWO_256 / target
        }

        prevHash = hr
      }

      if (onProgress) onProgress(end, total)
      await new Promise(r => setTimeout(r, 0))
    }

    this.tipHash = this.toHex(prevHash)
    this.verified = errors === 0
    const elapsed = ((performance.now() - start) / 1000).toFixed(1)

    this.dispatchEvent(new CustomEvent('verified', {
      detail: { passed: errors === 0, errors, work: totalWork, elapsed, tipHash: this.tipHash }
    }))

    return { passed: errors === 0, errors, work: totalWork, elapsed }
  }

  // Get header at height
  getHeader(height) {
    if (!this.headers || height > this.height) return null
    return this.headers.subarray(height * HEADER_SIZE, (height + 1) * HEADER_SIZE)
  }

  // Append a new header (from Electrum live update)
  appendHeader(headerHex) {
    const headerBuf = new Uint8Array(HEADER_SIZE)
    for (let i = 0; i < HEADER_SIZE; i++) {
      headerBuf[i] = parseInt(headerHex.substr(i * 2, 2), 16)
    }

    // Verify linkage
    if (this.height >= 0) {
      const prevHeader = this.getHeader(this.height)
      const expectedPrev = this.headerHash(prevHeader)
      const actualPrev = this.toHex(this.getPrevHash(headerBuf))
      if (actualPrev !== expectedPrev) {
        throw new Error('Chain break — new header does not link')
      }
    }

    // Append
    const newHeaders = new Uint8Array(this.headers.length + HEADER_SIZE)
    newHeaders.set(this.headers)
    newHeaders.set(headerBuf, this.headers.length)
    this.headers = newHeaders
    this.height++
    this.tipHash = this.headerHash(headerBuf)

    this.dispatchEvent(new CustomEvent('newblock', {
      detail: { height: this.height, hash: this.tipHash }
    }))

    return this.height
  }
}
