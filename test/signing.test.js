import { describe, it, before } from 'node:test'
import assert from 'node:assert'

let schnorr, secp256k1, sha256, bech32m, HDKey, mnemonicToSeedSync

describe('Taproot signing', () => {
  before(async () => {
    const curves = await import('@noble/curves/secp256k1.js')
    const hashes = await import('@noble/hashes/sha2.js')
    const bip32 = await import('@scure/bip32')
    const bip39 = await import('@scure/bip39')
    const base = await import('@scure/base')

    schnorr = curves.schnorr
    secp256k1 = curves.secp256k1
    sha256 = hashes.sha256
    HDKey = bip32.HDKey
    mnemonicToSeedSync = bip39.mnemonicToSeedSync
    bech32m = base.bech32m
  })

  // Helper functions (same as wallet-pane.js)
  function hexToBytes(hex) {
    const b = new Uint8Array(hex.length / 2)
    for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.substr(i, 2), 16)
    return b
  }
  function bytesToHex(b) {
    return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')
  }
  function bigintToLE(n, len) {
    const b = new Uint8Array(len)
    let temp = BigInt(n)
    for (let i = 0; i < len; i++) { b[i] = Number(temp & 0xffn); temp >>= 8n }
    return b
  }
  function taggedHash(tag, data) {
    const tagHash = sha256(new TextEncoder().encode(tag))
    return sha256(new Uint8Array([...tagHash, ...tagHash, ...data]))
  }
  function concat(...arrays) {
    const len = arrays.reduce((s, a) => s + a.length, 0)
    const r = new Uint8Array(len)
    let off = 0
    for (const a of arrays) { r.set(a, off); off += a.length }
    return r
  }

  // Derive key from known mnemonic
  function deriveKey(mnemonic, coinType) {
    const seed = mnemonicToSeedSync(mnemonic)
    const root = HDKey.fromMasterSeed(seed)
    return root.derive(`m/86'/${coinType}'/0'/0/0`)
  }

  it('BIP86 derivation produces 32-byte private key', () => {
    const child = deriveKey('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 0)
    assert.strictEqual(child.privateKey.length, 32)
  })

  it('schnorr.getPublicKey returns 32-byte x-only key', () => {
    const child = deriveKey('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 0)
    const pub = schnorr.getPublicKey(child.privateKey)
    assert.strictEqual(pub.length, 32)
  })

  it('address encodes correctly for mainnet', () => {
    const child = deriveKey('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 0)
    const pub = schnorr.getPublicKey(child.privateKey)
    const words = bech32m.toWords(pub)
    const addr = bech32m.encode('bc', [1, ...words])
    assert.ok(addr.startsWith('bc1p'))
    assert.ok(addr.length >= 62)
  })

  it('address encodes correctly for testnet', () => {
    const child = deriveKey('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 1)
    const pub = schnorr.getPublicKey(child.privateKey)
    const words = bech32m.toWords(pub)
    const addr = bech32m.encode('tb', [1, ...words])
    assert.ok(addr.startsWith('tb1p'))
  })

  it('P2TR output script is OP_1 PUSH32 pubkey', () => {
    const child = deriveKey('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 0)
    const pub = schnorr.getPublicKey(child.privateKey)
    const script = new Uint8Array([0x51, 0x20, ...pub])
    assert.strictEqual(script.length, 34)
    assert.strictEqual(script[0], 0x51) // OP_1
    assert.strictEqual(script[1], 0x20) // PUSH32
  })

  it('tagged hash TapSighash produces 32 bytes', () => {
    const data = new Uint8Array(100).fill(0xab)
    const result = taggedHash('TapSighash', data)
    assert.strictEqual(result.length, 32)
  })

  it('tagged hash TapTweak produces 32 bytes', () => {
    const data = new Uint8Array(32).fill(0xcd)
    const result = taggedHash('TapTweak', data)
    assert.strictEqual(result.length, 32)
  })

  it('signing with raw key verifies against x-only pubkey', () => {
    const child = deriveKey('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 0)
    const privKey = child.privateKey
    const pub = schnorr.getPublicKey(privKey)
    const msg = new Uint8Array(32).fill(0xaa)

    // Sign with y-parity handling (same as wallet-pane.js)
    let sigKey = new Uint8Array(privKey)
    const fullPub = secp256k1.getPublicKey(privKey, true)
    if (fullPub[0] === 0x03) {
      const n = secp256k1.Point.Fn.ORDER
      const neg = n - BigInt('0x' + bytesToHex(privKey))
      sigKey = hexToBytes(neg.toString(16).padStart(64, '0'))
    }

    const sig = schnorr.sign(msg, sigKey)
    assert.strictEqual(sig.length, 64)

    const valid = schnorr.verify(sig, msg, pub)
    assert.strictEqual(valid, true, 'Signature should verify against x-only pubkey')
  })

  it('signing with wrong key fails verification', () => {
    const child1 = deriveKey('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 0)
    const child2 = deriveKey('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', 0)

    const pub1 = schnorr.getPublicKey(child1.privateKey)
    const msg = new Uint8Array(32).fill(0xbb)
    const sig = schnorr.sign(msg, child2.privateKey) // sign with key2

    const valid = schnorr.verify(sig, msg, pub1) // verify with key1's pubkey
    assert.strictEqual(valid, false)
  })

  it('sighash construction matches expected format', () => {
    // Build a minimal sighash message matching BIP341 structure
    const version = bigintToLE(2, 4)
    const locktime = bigintToLE(0, 4)
    const hashPrevouts = new Uint8Array(32).fill(0x01)
    const hashAmounts = new Uint8Array(32).fill(0x02)
    const hashScriptPubkeys = new Uint8Array(32).fill(0x03)
    const hashSequences = new Uint8Array(32).fill(0x04)
    const hashOutputs = new Uint8Array(32).fill(0x05)

    const sigMsg = concat(
      new Uint8Array([0x00, 0x00]), // epoch, sighash type
      version, locktime,
      hashPrevouts, hashAmounts, hashScriptPubkeys, hashSequences, hashOutputs,
      new Uint8Array([0x00]), // spend type
      bigintToLE(0, 4), // input index
    )

    // epoch(1) + sighash_type(1) + version(4) + locktime(4) + 5×hash(160) + spend_type(1) + input_index(4)
    assert.strictEqual(sigMsg.length, 1 + 1 + 4 + 4 + 32 * 5 + 1 + 4)

    const sighash = taggedHash('TapSighash', sigMsg)
    assert.strictEqual(sighash.length, 32)
  })

  it('sighash is deterministic for same inputs', () => {
    const msg = new Uint8Array(175).fill(0xcc)
    const h1 = taggedHash('TapSighash', msg)
    const h2 = taggedHash('TapSighash', msg)
    assert.deepStrictEqual(h1, h2)
  })

  it('different inputs produce different sighash', () => {
    const msg1 = new Uint8Array(175).fill(0xcc)
    const msg2 = new Uint8Array(175).fill(0xdd)
    const h1 = taggedHash('TapSighash', msg1)
    const h2 = taggedHash('TapSighash', msg2)
    assert.notDeepStrictEqual(h1, h2)
  })

  it('full sign-verify cycle with sighash', () => {
    const child = deriveKey('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 1)
    const privKey = child.privateKey
    const pub = schnorr.getPublicKey(privKey)

    // Build sighash
    const version = bigintToLE(2, 4)
    const locktime = bigintToLE(0, 4)
    const fakeHash = new Uint8Array(32).fill(0xab)
    const sigMsg = concat(
      new Uint8Array([0x00, 0x00]),
      version, locktime,
      fakeHash, fakeHash, fakeHash, fakeHash, fakeHash,
      new Uint8Array([0x00]),
      bigintToLE(0, 4),
    )
    const sighash = taggedHash('TapSighash', sigMsg)

    // Sign with y-parity handling
    let sigKey = new Uint8Array(privKey)
    const fullPub = secp256k1.getPublicKey(privKey, true)
    if (fullPub[0] === 0x03) {
      const n = secp256k1.Point.Fn.ORDER
      const neg = n - BigInt('0x' + bytesToHex(privKey))
      sigKey = hexToBytes(neg.toString(16).padStart(64, '0'))
    }

    const sig = schnorr.sign(sighash, sigKey)
    const valid = schnorr.verify(sig, sighash, pub)
    assert.strictEqual(valid, true, 'Sighash signature should verify')
  })

  it('y-parity negation preserves x-only pubkey', () => {
    const child = deriveKey('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 0)
    const privKey = child.privateKey
    const pub = schnorr.getPublicKey(privKey)

    // Negate if needed
    const fullPub = secp256k1.getPublicKey(privKey, true)
    let sigKey = new Uint8Array(privKey)
    if (fullPub[0] === 0x03) {
      const n = secp256k1.Point.Fn.ORDER
      const neg = n - BigInt('0x' + bytesToHex(privKey))
      sigKey = hexToBytes(neg.toString(16).padStart(64, '0'))
    }

    // Negated key should produce same x-only pubkey
    const negatedPub = schnorr.getPublicKey(sigKey)
    assert.deepStrictEqual(negatedPub, pub, 'Negated key should produce same x-only pubkey')
  })

  it('transaction serialization version is little-endian 2', () => {
    const version = bigintToLE(2, 4)
    assert.deepStrictEqual(version, new Uint8Array([2, 0, 0, 0]))
  })

  it('value serialization for satoshi amounts', () => {
    // 100,000 sats = 0x186A0
    const val = bigintToLE(100000, 8)
    assert.strictEqual(val[0], 0xa0)
    assert.strictEqual(val[1], 0x86)
    assert.strictEqual(val[2], 0x01)
    assert.strictEqual(val[3], 0)
  })

  it('txid reversal for prevout', () => {
    const displayTxid = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
    const bytes = hexToBytes(displayTxid).reverse()
    assert.strictEqual(bytes[0], 0x89)
    assert.strictEqual(bytes[31], 0xab)
  })

  it('sequence 0xfffffffd is RBF-enabled', () => {
    const seq = new Uint8Array([0xfd, 0xff, 0xff, 0xff])
    const val = seq[0] | (seq[1] << 8) | (seq[2] << 16) | (seq[3] << 24)
    assert.strictEqual(val >>> 0, 0xfffffffd)
  })

  it('address roundtrip: encode then decode', () => {
    const child = deriveKey('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 1)
    const pub = schnorr.getPublicKey(child.privateKey)

    const words = bech32m.toWords(pub)
    const addr = bech32m.encode('tb', [1, ...words])

    const decoded = bech32m.decode(addr)
    const program = bech32m.fromWords(decoded.words.slice(1))
    assert.deepStrictEqual(new Uint8Array(program), pub)
  })

  it('output script from address matches direct construction', () => {
    const child = deriveKey('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 0)
    const pub = schnorr.getPublicKey(child.privateKey)

    // Direct construction
    const directScript = new Uint8Array([0x51, 0x20, ...pub])

    // Via address decode
    const words = bech32m.toWords(pub)
    const addr = bech32m.encode('bc', [1, ...words])
    const decoded = bech32m.decode(addr)
    const program = bech32m.fromWords(decoded.words.slice(1))
    const decodedScript = new Uint8Array([0x51, 0x20, ...program])

    assert.deepStrictEqual(decodedScript, directScript)
  })
})
