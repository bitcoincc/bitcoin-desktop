# Bitcoin Desktop — Architecture & Build Guide

## What This Is

A Bitcoin desktop client that verifies the blockchain, downloads blocks, serves SPV proofs, and includes a Taproot wallet. Runs as an Electron app (GUI), headless Node.js process, or pure browser. Multi-chain: Bitcoin mainnet (btc) and testnet4 (tbtc4), extensible to any Bitcoin-derived chain.

## Core Insight

Bitcoin's data is 95% immutable. Serve it like static files. Headers are 80 bytes each (~75MB total chain). Blocks are immutable once mined. The entire verification infrastructure fits in a browser. No full node required for payment verification — just headers + merkle proofs (SPV, Section 8 of the whitepaper).

## Architecture

### Three-Tier Header Distribution

```
Tier 1: Archived Epochs    → immutable .bin files on CDN (Cache-Control: immutable)
Tier 2: Current Epoch      → mutable, append-only, short cache TTL
Tier 3: Live Stream         → Nostr NIP-333 (kind 33333) WebSocket push
```

Headers are binary: concatenated 80-byte Bitcoin block headers. MIME type: `application/vnd.bitcoin.headers`. One epoch = 2016 headers (Bitcoin difficulty adjustment period).

### Block Sources (priority order)

```
1. Local cache          ~/.bitcoin-desktop/{chain}/blocks/{epoch}/{height}.bin
2. JSS (Solid server)   http://localhost:8443/{chain}/blocks/{epoch}/{height}.bin
3. R2 CDN               https://{r2-url}/{chain}/blocks/{epoch}/{height}.bin
4. Bitcoin P2P network   TCP port 8333 (mainnet) / 48333 (testnet4)
5. Blockstream API       https://blockstream.info/api/block/{hash}/raw (fallback, rate limited)
```

Each source is a pluggable module in `js/sources/`. Add a new chain by adding its config (genesis hash, ports, DNS seeds).

### HTFU Verification Model

Consensus rules classified by what data they need:

```
H — Header-Only:      verifiable from 80-byte headers alone
T — Transaction-Level: requires full blocks (merkle root, scripts)
F — Fraud-Provable:    compact fraud proofs (coinbase reward, block weight)
U — UTXO-Dependent:    requires UTXO set (double-spend, input validation)
```

The app verifies incrementally: H-class always (7 seconds for full chain), T-class for blocks in the retention window, F and U are future.

### H-Class Rules (implemented)

1. Genesis block hash matches known value
2. Previous block hash links correctly (chain continuity)
3. Proof-of-work meets difficulty target
4. Difficulty retarget correct at epoch boundaries (mainnet only, testnets have special rules)
5. Timestamp > median of previous 11 blocks
6. Block version valid for BIP 34/66/65 activation heights (mainnet only)

### T-Class Rules (implemented)

1. Merkle root recomputed from all transactions matches header

## Directory Structure

```
bitcoin-desktop/
├── index.html              ← LOSOS shell (minimal, loads panes)
├── main.js                 ← Electron main process (JSS + proof server)
├── headless.js             ← Node.js headless mode (no GUI)
├── package.json            ← npm, AGPL-3.0 license
├── panes/
│   ├── node-pane.js        ← Node UI: phases, HTFU table, live stats, tx verify
│   ├── wallet-pane.js      ← Wallet: generate, import, send, receive (Taproot P2TR)
│   └── settings-pane.js    ← Settings: recipes, HTFU level, retention, score
├── js/
│   ├── app.js              ← Main orchestrator: download → verify → nostr → blocks
│   ├── headers.js          ← Header download, verification, WASM SHA-256
│   ├── blocks.js           ← Block fetcher: multi-source, verified, cached, pruned
│   ├── storage.js          ← Persistence: filesystem (Electron/Node) or IndexedDB (browser)
│   ├── config.js           ← Defaults, recipes, node scoring, per-chain settings
│   ├── scanner.js          ← Block scanner: watches for wallet transactions
│   ├── merkle.js           ← Merkle root verification + proof generation
│   ├── uploader.js         ← Upload verified blocks to R2 CDN via Worker
│   ├── electrum.js          ← Electrum client (WSS browser, TCP Node) — for future wallet features
│   ├── proof-server.js     ← HTTP API serving merkle proofs to SPV clients
│   └── sources/
│       ├── local.js        ← Local filesystem/IndexedDB cache
│       ├── jss.js          ← JavaScript Solid Server (local or remote)
│       ├── r2.js           ← Cloudflare R2 CDN
│       ├── p2p.js          ← Bitcoin P2P network (TCP, desktop only)
│       ├── blockstream.js  ← Blockstream.info Esplora API
│       └── mempool.js      ← mempool.space API
└── test/
    ├── blocks.test.js      ← Storage, config, sources, saved blocks tests
    └── wallet.test.js      ← Crypto, key derivation, signing, address encoding tests
```

## Data Directory

```
~/.bitcoin-desktop/
├── config.json                         ← user settings (chain, retention, sources, HTFU level)
├── .acl                                ← Web Access Control (public read for JSS)
├── btc/
│   ├── headers.bin                     ← all headers, binary, same format as R2
│   ├── headers-verified.json           ← cached verification result
│   ├── blocks/
│   │   └── 466/                        ← epoch directory
│   │       ├── 940730.bin              ← raw block (same bytes as Bitcoin P2P protocol)
│   │       ├── 940731.bin
│   │       └── ...
│   └── wallet/
│       └── keys.json                   ← mnemonic or hex private key
└── tbtc4/
    ├── headers.bin
    ├── headers-verified.json
    ├── blocks/
    │   └── 62/
    │       ├── 125900.bin
    │       └── ...
    └── wallet/
        └── keys.json
```

## Adding a New Chain

To add support for a new Bitcoin-derived chain (e.g., tbtc3, litecoin):

### 1. Config (`js/config.js`)

```js
blockFloor: {
  btc: 878000,
  tbtc4: 0,
  tbtc3: 0,        // add new chain
},
assumeValidWindow: {
  btc: 4320,
  tbtc4: 0,
  tbtc3: 0,        // add new chain
},
```

### 2. Genesis Hash (`js/headers.js` — HeaderStore)

```js
const GENESIS_HASHES = {
  btc: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
  tbtc4: '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043',
  tbtc3: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943',  // add
}
```

### 3. R2 CDN Path

Headers uploaded to: `{chain}/all.bin`, `{chain}/epoch/{n}.bin`, `{chain}/current.bin`
Blocks uploaded to: `{chain}/blocks/{epoch}/{height}.bin`

### 4. P2P Source (`js/sources/p2p.js`)

```js
const MAGIC = {
  btc: Buffer.from('f9beb4d9', 'hex'),
  tbtc4: Buffer.from('1c163f28', 'hex'),
  tbtc3: Buffer.from('0b110907', 'hex'),  // add magic bytes
}
const SEEDS = {
  btc: ['seed.bitcoin.sipa.be', ...],
  tbtc4: ['seed.testnet4.bitcoin.sprovoost.nl'],
  tbtc3: ['testnet-seed.bitcoin.jonasschnelli.ch', ...],  // add DNS seeds
}
```

Port: 8333 (mainnet), 18333 (testnet3), 48333 (testnet4).

### 5. Electrum Servers (`js/electrum.js`)

```js
const SERVERS = {
  btc: { wss: [...], tcp: [...] },
  tbtc4: { wss: [], tcp: [{ host: 'mempool.space', port: 40002 }] },
  tbtc3: { wss: [], tcp: [{ host: 'electrum.blockstream.info', port: 60002 }] },  // add
}
```

### 6. Wallet Address Prefix (`panes/wallet-pane.js`)

```js
const hrp = chain === 'btc' ? 'bc' : 'tb'  // tb covers both tbtc3 and tbtc4
const coinType = chain === 'btc' ? 0 : 1   // BIP44 coin type
```

### 7. Block Explorer API

```js
const api = chain === 'btc' ? 'https://mempool.space/api'
  : chain === 'tbtc4' ? 'https://mempool.space/testnet4/api'
  : 'https://mempool.space/testnet/api'  // tbtc3
```

### 8. R2 Daemon (`scripts/r2-daemon.js` in headers repo)

Run with `R2_CHAIN=tbtc3` environment variable. The daemon syncs headers from Electrum and uploads to R2.

### 9. Nostr NIP-333

The Nostr publisher needs to publish headers for the new chain with `["n", "tbtc3"]` tag. The chain pane filters by the `n` tag.

## Key Design Decisions

### Block Format
Raw block bytes — no wrapper, no obfuscation. Same bytes as Bitcoin P2P `block` message payload. Filename IS the index: `{epoch}/{height}.bin`. No database needed.

### Header Format
Concatenated 80-byte headers in binary. `all.bin` = full chain. `epoch/{n}.bin` = one difficulty period. Same format everywhere: R2, local cache, JSS. MIME type: `application/vnd.bitcoin.headers; chain=btc`.

### WASM SHA-256
Uses `hash-wasm` for verification — WASM SHA-256 is faster than WebCrypto for many small hashes (no async overhead). Loaded from npm locally (Node/Electron) or CDN (`esm.sh`) in browser.

### Crypto Libraries
All from `@noble` / `@scure` family (audited, no dependencies):
- `@noble/curves` — secp256k1, Schnorr signatures
- `@noble/hashes` — SHA-256
- `@scure/bip39` — mnemonic generation
- `@scure/bip32` — HD key derivation
- `@scure/base` — bech32m encoding

In Electron: loaded via `esm.sh` CDN (renderer can't resolve bare npm specifiers).
In Node.js headless: loaded directly from `node_modules`.

### Wallet
Taproot only (P2TR, BIP86). Key-path spend with Schnorr signatures (BIP340). Sighash computed per BIP341. Address uses untweaked x-only pubkey (not BIP86 tweaked — simpler, same as Nostr keys).

### Self-Healing Sync
On startup: load cached headers → check R2 for updates → fill gaps with `current.bin` or epoch files → connect Nostr for live tip. Minimum data downloaded to get current.

### Block Upload
Every client that fetches a block from P2P uploads it to R2 via a Cloudflare Worker proxy. The CDN fills itself through usage. No central infrastructure needed.

## Infrastructure (headers repo — bitcoincc/headers)

### R2 Bucket Structure
```
bitcoin-headers/
  btc/
    all.bin, current.bin, epoch/0..465.bin
    blocks/466/940730.bin, ...
  tbtc4/
    all.bin, current.bin, epoch/0..62.bin
    blocks/62/125900.bin, ...
```

### R2 Daemons (pm2)
- `btc-r2-daemon` — syncs mainnet headers from Electrum, uploads to R2
- `tbtc4-r2-daemon` — syncs testnet4 headers, uploads to R2
- Config: `R2_CHAIN=btc|tbtc4`, uses wrangler CLI (or S3 API with credentials)

### Cloudflare Worker
`workers/block-upload.js` — accepts `PUT /{chain}/blocks/{epoch}/{height}.bin` from clients, writes to R2. Validates size/path, no auth needed, CORS enabled.

### Public URLs
- Headers: `https://pub-{id}.r2.dev/{chain}/all.bin`
- Blocks: `https://pub-{id}.r2.dev/{chain}/blocks/{epoch}/{height}.bin`
- CORS enabled, `Cache-Control: immutable` on archived epochs

## Running

### Electron (GUI)
```bash
npm install
npm start
```

### Headless (no GUI, servers only)
```bash
npm run headless
# or with specific chain:
npm run headless -- --chain tbtc4
```

### Tests
```bash
npm test    # 44 tests: storage, config, sources, wallet crypto, signing
```

### Web (browser, no Electron)
```bash
npx serve .
# Open http://localhost:3000
# Note: P2P source won't work (no TCP in browser)
```

## Ports
- 8443: JSS (Solid server) — serves blocks, headers, wallet data over HTTP
- 8444: Proof server — serves merkle proofs via `/api/proof/{height}/{txid}`

## Key Metrics
- Headers: 72MB for full Bitcoin chain, verified in ~7 seconds (WASM)
- Blocks: ~650KB average, fetched from P2P in ~2 seconds per block
- Merkle proof: ~400 bytes (13 hashes for 5000-tx block)
- Storage: configurable retention (12-1000+ blocks), auto-pruned
- Node score: 0-1000 based on HTFU level + sync status + contributions

## Cost
- R2 storage: free tier 10GB (headers + recent blocks fit easily)
- R2 egress: $0 always
- R2 reads: 10M/month free
- Total for full chain (600GB): ~$9/month
- Serving to the world: $0

## License
AGPL-3.0-or-later (C) 2026 Melvin Carvalho
