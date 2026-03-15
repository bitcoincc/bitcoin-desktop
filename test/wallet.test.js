import { describe, it, before } from 'node:test'
import assert from 'node:assert'

// These are ESM packages — use dynamic import with .js suffix
let schnorr, secp256k1, sha256, generateMnemonic, mnemonicToSeedSync, HDKey, bech32m, wordlist

describe('Wallet crypto', () => {
  before(async () => {
    const curves = await import('@noble/curves/secp256k1.js')
    const hashes = await import('@noble/hashes/sha2.js')
    const bip39 = await import('@scure/bip39')
    const bip32 = await import('@scure/bip32')
    const base = await import('@scure/base')
    const words = await import('@scure/bip39/wordlists/english.js')

    schnorr = curves.schnorr
    secp256k1 = curves.secp256k1
    sha256 = hashes.sha256
    generateMnemonic = bip39.generateMnemonic
    mnemonicToSeedSync = bip39.mnemonicToSeedSync
    HDKey = bip32.HDKey
    bech32m = base.bech32m
    wordlist = words.wordlist
  })

  it('generates 12-word mnemonic', () => {
    const mnemonic = generateMnemonic(wordlist, 128)
    const words = mnemonic.split(' ')
    assert.strictEqual(words.length, 12)
  })

  it('derives BIP86 taproot key from mnemonic', () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const seed = mnemonicToSeedSync(mnemonic)
    const root = HDKey.fromMasterSeed(seed)
    const child = root.derive("m/86'/0'/0'/0/0")

    assert.ok(child.privateKey)
    assert.strictEqual(child.privateKey.length, 32)
  })

  it('generates x-only public key from private key', () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const seed = mnemonicToSeedSync(mnemonic)
    const root = HDKey.fromMasterSeed(seed)
    const child = root.derive("m/86'/0'/0'/0/0")

    const xOnlyPub = schnorr.getPublicKey(child.privateKey)
    assert.strictEqual(xOnlyPub.length, 32)
  })

  it('generates valid mainnet P2TR address (bc1p)', () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const seed = mnemonicToSeedSync(mnemonic)
    const root = HDKey.fromMasterSeed(seed)
    const child = root.derive("m/86'/0'/0'/0/0")

    const xOnlyPub = schnorr.getPublicKey(child.privateKey)
    const words = bech32m.toWords(xOnlyPub)
    const address = bech32m.encode('bc', [1, ...words])

    assert.ok(address.startsWith('bc1p'))
    assert.ok(address.length >= 62)
  })

  it('generates valid testnet P2TR address (tb1p)', () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const seed = mnemonicToSeedSync(mnemonic)
    const root = HDKey.fromMasterSeed(seed)
    const child = root.derive("m/86'/1'/0'/0/0") // testnet coin type 1

    const xOnlyPub = schnorr.getPublicKey(child.privateKey)
    const words = bech32m.toWords(xOnlyPub)
    const address = bech32m.encode('tb', [1, ...words])

    assert.ok(address.startsWith('tb1p'))
    assert.ok(address.length >= 62)
  })

  it('different coin types produce different addresses', () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const seed = mnemonicToSeedSync(mnemonic)
    const root = HDKey.fromMasterSeed(seed)

    const mainnet = root.derive("m/86'/0'/0'/0/0")
    const testnet = root.derive("m/86'/1'/0'/0/0")

    const mainPub = schnorr.getPublicKey(mainnet.privateKey)
    const testPub = schnorr.getPublicKey(testnet.privateKey)

    assert.notDeepStrictEqual(mainPub, testPub)
  })

  it('same mnemonic always produces same address', () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

    for (let i = 0; i < 3; i++) {
      const seed = mnemonicToSeedSync(mnemonic)
      const root = HDKey.fromMasterSeed(seed)
      const child = root.derive("m/86'/0'/0'/0/0")
      const pub = schnorr.getPublicKey(child.privateKey)
      const words = bech32m.toWords(pub)
      const addr = bech32m.encode('bc', [1, ...words])

      if (i === 0) var firstAddr = addr
      else assert.strictEqual(addr, firstAddr)
    }
  })

  it('bech32m decode roundtrips', () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const seed = mnemonicToSeedSync(mnemonic)
    const root = HDKey.fromMasterSeed(seed)
    const child = root.derive("m/86'/0'/0'/0/0")
    const xOnlyPub = schnorr.getPublicKey(child.privateKey)

    const words = bech32m.toWords(xOnlyPub)
    const address = bech32m.encode('bc', [1, ...words])

    const decoded = bech32m.decode(address)
    const program = bech32m.fromWords(decoded.words.slice(1))

    assert.deepStrictEqual(new Uint8Array(program), xOnlyPub)
  })
})

describe('Transaction helpers', () => {
  before(async () => {
    if (!schnorr) {
      const curves = await import('@noble/curves/secp256k1.js')
      const hashes = await import('@noble/hashes/sha2.js')
      schnorr = curves.schnorr
      secp256k1 = curves.secp256k1
      sha256 = hashes.sha256
    }
  })

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
  function varInt(n) {
    if (n < 0xfd) return new Uint8Array([n])
    if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff])
    return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff])
  }
  function taggedHash(tag, data) {
    const tagHash = sha256(new TextEncoder().encode(tag))
    return sha256(new Uint8Array([...tagHash, ...tagHash, ...data]))
  }

  it('hexToBytes and bytesToHex roundtrip', () => {
    const hex = 'deadbeef01020304'
    assert.strictEqual(bytesToHex(hexToBytes(hex)), hex)
  })

  it('bigintToLE encodes correctly', () => {
    assert.deepStrictEqual(bigintToLE(0, 4), new Uint8Array([0, 0, 0, 0]))
    assert.deepStrictEqual(bigintToLE(1, 4), new Uint8Array([1, 0, 0, 0]))
    assert.deepStrictEqual(bigintToLE(256, 4), new Uint8Array([0, 1, 0, 0]))
    assert.deepStrictEqual(bigintToLE(0xdeadbeef, 4), new Uint8Array([0xef, 0xbe, 0xad, 0xde]))
  })

  it('bigintToLE 8 bytes for satoshi values', () => {
    const sats = bigintToLE(1000000, 8) // 1M sats
    assert.strictEqual(sats.length, 8)
    // 1000000 = 0xF4240
    assert.strictEqual(sats[0], 0x40)
    assert.strictEqual(sats[1], 0x42)
    assert.strictEqual(sats[2], 0x0f)
  })

  it('varInt encodes small values', () => {
    assert.deepStrictEqual(varInt(0), new Uint8Array([0]))
    assert.deepStrictEqual(varInt(1), new Uint8Array([1]))
    assert.deepStrictEqual(varInt(252), new Uint8Array([252]))
  })

  it('varInt encodes medium values', () => {
    assert.deepStrictEqual(varInt(253), new Uint8Array([0xfd, 253, 0]))
    assert.deepStrictEqual(varInt(256), new Uint8Array([0xfd, 0, 1]))
  })

  it('taggedHash produces 32 bytes', () => {
    const result = taggedHash('TapSighash', new Uint8Array([1, 2, 3]))
    assert.strictEqual(result.length, 32)
  })

  it('taggedHash is deterministic', () => {
    const a = taggedHash('TapTweak', new Uint8Array([1, 2, 3]))
    const b = taggedHash('TapTweak', new Uint8Array([1, 2, 3]))
    assert.deepStrictEqual(a, b)
  })

  it('taggedHash different tags produce different results', () => {
    const a = taggedHash('TapTweak', new Uint8Array([1, 2, 3]))
    const b = taggedHash('TapSighash', new Uint8Array([1, 2, 3]))
    assert.notDeepStrictEqual(a, b)
  })

  it('P2TR output script is 34 bytes', () => {
    const fakePubkey = new Uint8Array(32).fill(0xab)
    const script = new Uint8Array([0x51, 0x20, ...fakePubkey])
    assert.strictEqual(script.length, 34)
    assert.strictEqual(script[0], 0x51) // OP_1
    assert.strictEqual(script[1], 0x20) // PUSH32
  })

  it('txid bytes are reversed from display', () => {
    const displayTxid = 'd0c9c3234f96a6278790ed0b064d83ebaf26161f8039fed354a69f872afef595'
    const bytes = hexToBytes(displayTxid).reverse()
    // Internal byte order — last display byte first
    assert.strictEqual(bytes[0], 0x95)
    assert.strictEqual(bytes[31], 0xd0)
  })

  it('Schnorr signature is 64 bytes', () => {
    const privKey = new Uint8Array(32)
    privKey[31] = 1 // minimal valid private key
    const msg = new Uint8Array(32).fill(0xaa)
    const sig = schnorr.sign(msg, privKey)
    assert.strictEqual(sig.length, 64)
  })

  it('Schnorr signature verifies', () => {
    const privKey = new Uint8Array(32)
    privKey[31] = 1
    const pub = schnorr.getPublicKey(privKey)
    const msg = new Uint8Array(32).fill(0xbb)
    const sig = schnorr.sign(msg, privKey)
    const valid = schnorr.verify(sig, msg, pub)
    assert.strictEqual(valid, true)
  })

  it('wrong key produces invalid signature', () => {
    const privKey1 = new Uint8Array(32); privKey1[31] = 1
    const privKey2 = new Uint8Array(32); privKey2[31] = 2
    const pub2 = schnorr.getPublicKey(privKey2)
    const msg = new Uint8Array(32).fill(0xcc)
    const sig = schnorr.sign(msg, privKey1) // signed with key1
    const valid = schnorr.verify(sig, msg, pub2) // verify with key2
    assert.strictEqual(valid, false)
  })
})
