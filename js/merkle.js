/**
 * Merkle root computation and verification
 *
 * Recomputes the merkle root from all transactions in a block
 * and verifies it matches the root in the block header.
 * This is the first T-class consensus rule.
 */

export class MerkleVerifier {
  constructor(hasher) {
    this.hasher = hasher // hash-wasm SHA256 instance
  }

  // Double SHA-256
  hash256(data) {
    this.hasher.init()
    this.hasher.update(data)
    const h1 = this.hasher.digest('binary')
    this.hasher.init()
    this.hasher.update(h1)
    return this.hasher.digest('binary')
  }

  // Compute merkle root from list of transaction hashes (each 32 bytes)
  computeRoot(txHashes) {
    if (txHashes.length === 0) return null
    if (txHashes.length === 1) return txHashes[0]

    let level = txHashes.map(h => new Uint8Array(h))

    while (level.length > 1) {
      const next = []
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i]
        const right = i + 1 < level.length ? level[i + 1] : level[i] // duplicate last if odd
        const combined = new Uint8Array(64)
        combined.set(left, 0)
        combined.set(right, 32)
        next.push(this.hash256(combined))
      }
      level = next
    }

    return level[0]
  }

  // Parse a raw block and extract transaction hashes
  extractTxHashes(blockData) {
    const data = new Uint8Array(blockData)
    let offset = 80 // skip header

    // Read tx count (varint)
    let txCount = data[offset]
    offset++
    if (txCount === 0xfd) { txCount = data[offset] | (data[offset + 1] << 8); offset += 2 }
    else if (txCount === 0xfe) { txCount = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24); offset += 4 }

    const txHashes = []

    for (let t = 0; t < txCount; t++) {
      const txStart = offset

      // Version (4 bytes)
      offset += 4

      // Check for SegWit marker
      let hasWitness = false
      if (data[offset] === 0x00 && data[offset + 1] !== 0x00) {
        hasWitness = true
        offset += 2 // marker + flag
      }

      // Inputs
      let inCount = data[offset]; offset++
      if (inCount === 0xfd) { inCount = data[offset] | (data[offset + 1] << 8); offset += 2 }

      for (let i = 0; i < inCount; i++) {
        offset += 32 + 4 // prevhash + previndex
        let scriptLen = data[offset]; offset++
        if (scriptLen === 0xfd) { scriptLen = data[offset] | (data[offset + 1] << 8); offset += 2 }
        offset += scriptLen + 4 // script + sequence
      }

      // Outputs
      let outCount = data[offset]; offset++
      if (outCount === 0xfd) { outCount = data[offset] | (data[offset + 1] << 8); offset += 2 }

      for (let i = 0; i < outCount; i++) {
        offset += 8 // value
        let scriptLen = data[offset]; offset++
        if (scriptLen === 0xfd) { scriptLen = data[offset] | (data[offset + 1] << 8); offset += 2 }
        offset += scriptLen
      }

      // Witness data
      if (hasWitness) {
        for (let i = 0; i < inCount; i++) {
          let witCount = data[offset]; offset++
          for (let j = 0; j < witCount; j++) {
            let itemLen = data[offset]; offset++
            if (itemLen === 0xfd) { itemLen = data[offset] | (data[offset + 1] << 8); offset += 2 }
            offset += itemLen
          }
        }
      }

      // Locktime (4 bytes)
      offset += 4

      // For txid: hash the non-witness serialization
      // Non-witness = version + inputs + outputs + locktime (no marker/flag/witness)
      let txBytes
      if (hasWitness) {
        // Reconstruct without witness
        const version = data.slice(txStart, txStart + 4)
        const afterFlag = txStart + 6 // skip version(4) + marker(1) + flag(1)

        // Find where witness starts by re-parsing inputs+outputs
        let pos = afterFlag
        let ic = data[pos]; pos++
        if (ic === 0xfd) { ic = data[pos] | (data[pos + 1] << 8); pos += 2 }
        for (let i = 0; i < ic; i++) {
          pos += 36
          let sl = data[pos]; pos++
          if (sl === 0xfd) { sl = data[pos] | (data[pos + 1] << 8); pos += 2 }
          pos += sl + 4
        }
        let oc = data[pos]; pos++
        if (oc === 0xfd) { oc = data[pos] | (data[pos + 1] << 8); pos += 2 }
        for (let i = 0; i < oc; i++) {
          pos += 8
          let sl = data[pos]; pos++
          if (sl === 0xfd) { sl = data[pos] | (data[pos + 1] << 8); pos += 2 }
          pos += sl
        }
        const insOuts = data.slice(afterFlag, pos)
        const locktime = data.slice(offset - 4, offset)
        txBytes = new Uint8Array(4 + insOuts.length + 4)
        txBytes.set(version, 0)
        txBytes.set(insOuts, 4)
        txBytes.set(locktime, 4 + insOuts.length)
      } else {
        txBytes = data.slice(txStart, offset)
      }

      txHashes.push(this.hash256(txBytes))
    }

    return txHashes
  }

  // Verify a block's merkle root matches its header
  verifyBlock(blockData) {
    const data = new Uint8Array(blockData)
    if (data.length < 81) return { valid: false, error: 'Block too small' }

    // Extract merkle root from header (bytes 36-68, internal byte order)
    const headerRoot = data.slice(36, 68)

    // Compute merkle root from transactions
    const txHashes = this.extractTxHashes(data)
    if (txHashes.length === 0) return { valid: false, error: 'No transactions found' }

    const computedRoot = this.computeRoot(txHashes)

    // Compare (both in internal byte order)
    let match = true
    for (let i = 0; i < 32; i++) {
      if (headerRoot[i] !== computedRoot[i]) { match = false; break }
    }

    return {
      valid: match,
      txCount: txHashes.length,
      headerRoot: Array.from(headerRoot).map(b => b.toString(16).padStart(2, '0')).join(''),
      computedRoot: Array.from(computedRoot).map(b => b.toString(16).padStart(2, '0')).join(''),
    }
  }
}
