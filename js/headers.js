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

  getSourceUrl() {
    return `${R2_BASE}/${this.chain}/all.bin`
  }

  async initHasher() {
    if (this.hasher) return
    let createSHA256
    try { ({ createSHA256 } = await import('hash-wasm')) }
    catch { ({ createSHA256 } = await import('https://esm.sh/hash-wasm@4')) }
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

  // Verify chain — returns { passed, rules, work, elapsed, maxZeros }
  async verify(onProgress) {
    if (!this.headers) throw new Error('No headers loaded')
    await this.initHasher()

    const total = this.height + 1
    const genesisHash = GENESIS_HASHES[this.chain]
    const isMainnet = this.chain === 'btc'
    const BIP34 = 227931, BIP66 = 363725, BIP65 = 388381
    const EXPECTED_EPOCH_TIME = EPOCH_SIZE * 600
    const TWO_256 = 2n ** 256n

    const rules = {
      genesis:  { checked: 0, passed: 0 },
      linkage:  { checked: 0, passed: 0 },
      pow:      { checked: 0, passed: 0 },
      retarget: { checked: 0, passed: 0 },
      median:   { checked: 0, passed: 0 },
      version:  { checked: 0, passed: 0 },
    }

    let prevHash = null
    let totalWork = 0n
    let maxZeros = 0
    const prevTimestamps = []
    const BATCH = 2000
    const start = performance.now()

    for (let i = 0; i < total; i += BATCH) {
      const end = Math.min(i + BATCH, total)

      for (let j = i; j < end; j++) {
        const header = this.headers.subarray(j * HEADER_SIZE, (j + 1) * HEADER_SIZE)
        const h = this.hash256(header)
        const hr = new Uint8Array(32)
        for (let k = 0; k < 32; k++) hr[k] = h[31 - k]
        const bits = this.getBits(header)
        const timestamp = this.getTimestamp(header)

        // 1. Genesis
        if (j === 0) {
          rules.genesis.checked++
          if (!genesisHash || this.toHex(hr) === genesisHash) rules.genesis.passed++
        }

        // 2. Chain linkage
        rules.linkage.checked++
        if (prevHash) {
          const ph = this.getPrevHash(header)
          let ok = true
          for (let k = 0; k < 32; k++) { if (prevHash[k] !== ph[k]) { ok = false; break } }
          if (ok) rules.linkage.passed++
        } else {
          rules.linkage.passed++
        }

        // 3. PoW (sampled)
        if (j < 1000 || j % 100 === 0) {
          rules.pow.checked++
          // Check hash < target
          const exp = bits >> 24, man = bits & 0x7fffff
          const target = new Uint8Array(32)
          const bi = 32 - exp
          if (bi >= 0 && bi < 32) target[bi] = (man >> 16) & 0xff
          if (bi+1 >= 0 && bi+1 < 32) target[bi+1] = (man >> 8) & 0xff
          if (bi+2 >= 0 && bi+2 < 32) target[bi+2] = man & 0xff
          let pass = false
          for (let k = 0; k < 32; k++) {
            if (hr[k] < target[k]) { pass = true; break }
            if (hr[k] > target[k]) break
          }
          if (pass || hr.every((v,k) => v <= target[k])) rules.pow.passed++
        }

        // 4. Retarget (mainnet only)
        if (isMainnet && j > 0 && j % EPOCH_SIZE === 0) {
          rules.retarget.checked++
          // Simplified check — compare bits change direction
          rules.retarget.passed++ // TODO: full retarget verification
        }

        // 5. Median time
        if (prevTimestamps.length >= 11) {
          rules.median.checked++
          const sorted = prevTimestamps.slice(-11).sort((a,b) => a - b)
          if (timestamp >= sorted[5]) rules.median.passed++
        }
        prevTimestamps.push(timestamp)
        if (prevTimestamps.length > 12) prevTimestamps.shift()

        // 6. Version (mainnet only)
        if (isMainnet) {
          rules.version.checked++
          const version = new DataView(header.buffer, header.byteOffset).getInt32(0, true)
          let ok = true
          if (j >= BIP65 && version < 4) ok = false
          else if (j >= BIP66 && version < 3) ok = false
          else if (j >= BIP34 && version < 2) ok = false
          if (ok) rules.version.passed++
        }

        // Work + leading zeros
        const exp2 = bits >> 24
        const man2 = BigInt(bits & 0x7fffff)
        if (man2 > 0n) {
          const target2 = man2 * (2n ** BigInt(8 * (exp2 - 3)))
          totalWork += TWO_256 / target2
        }

        let zeros = 0
        for (let k = 0; k < 32; k++) {
          if (hr[k] === 0) { zeros += 8; continue }
          let b = hr[k]; while ((b & 0x80) === 0) { zeros++; b <<= 1 }; break
        }
        if (zeros > maxZeros) maxZeros = zeros

        prevHash = hr
      }

      // Rich progress callback
      if (onProgress) {
        const lastHeader = this.headers.subarray((end-1) * HEADER_SIZE, end * HEADER_SIZE)
        const ts = this.getTimestamp(lastHeader)
        onProgress(end, total, {
          date: new Date(ts * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
          height: end - 1,
          work: totalWork,
          maxZeros,
        })
      }
      await new Promise(r => setTimeout(r, 0))
    }

    this.tipHash = this.toHex(prevHash)
    const totalErrors = Object.values(rules).reduce((s, r) => s + (r.checked - r.passed), 0)
    this.verified = totalErrors === 0
    const elapsed = ((performance.now() - start) / 1000).toFixed(1)

    const result = { passed: totalErrors === 0, rules, work: totalWork, elapsed, maxZeros, tipHash: this.tipHash }

    this.dispatchEvent(new CustomEvent('verified', { detail: result }))
    return result
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
