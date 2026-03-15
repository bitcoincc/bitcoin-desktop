/**
 * Configuration — defaults and user overrides
 *
 * Stored at ~/.bitcoin-desktop/config.json (Electron) or IndexedDB (browser)
 */

export const DEFAULTS = {
  // Chain
  chain: 'btc',

  // HTFU verification level
  htfu: {
    h: true,          // Header-only (always on)
    t: false,         // Transaction-level (needs blocks)
    f: false,         // Fraud-provable (needs blocks)
    u: false,         // UTXO-dependent (needs UTXO set)
  },

  // Block retention
  retention: 12,      // 12 = default (matches Nostr NIP-333 batch size)
                      // 0 = headers only, no blocks
                      // 100 = light history
                      // 2016 = one full epoch
                      // 4032 = rolling full validation
                      // -1 = archive everything

  // Block sources (in priority order)
  sources: [
    'local',          // local cache first
    'jss',            // local Solid server (if running)
    'r2',             // R2 CDN — blocks uploaded by other clients
    'p2p',            // Bitcoin P2P network (fallback, no rate limits)
    // 'blockstream', // blockstream.info API (emergency fallback)
  ],

  // Rate limiting
  rateLimit: 5000,    // ms between block API requests

  // Block range — don't fetch individual blocks before this height
  // Older blocks served from blk.dat bundles (future)
  blockFloor: {
    btc: 878000,       // ~Jan 2026
    tbtc4: 0,          // testnet4: fetch everything (small chain)
  },

  // AssumeValid — skip script validation for blocks older than this window
  // Blocks within window get full T-class verification
  assumeValidWindow: {
    btc: 4320,         // ~1 month of blocks (rolling)
    tbtc4: 0,          // validate everything (small chain)
  },

  // Bootstrap
  bootstrapBlocks: 12, // fetch last 12 blocks on startup (matches NIP-333 batch)

  // R2 contribution
  contributeBlocks: true,   // upload verified blocks to R2 (helps the network)

  // Solid server (JSS)
  serveBlocks: false,   // serve blocks locally via JSS
  serverPort: 8443,     // JSS port

  // Transaction pool (filtered mempool)
  txpoolEnabled: false, // listen for unconfirmed txs via P2P
  peers: [],            // remote JSS peers e.g. ['192.168.0.157:8443']

  // R2 configuration (for contribution)
  r2: {
    bucket: 'bitcoin-headers',
    publicUrl: 'https://pub-a5a92731dd0d452b9670be07e5354fd6.r2.dev',
  },

  // Nostr relays
  relays: [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.net',
    'wss://relay.primal.net',
  ],

  // Node score weights (out of 1000)
  scoring: {
    h: 100,           // headers verified
    t: 300,           // transaction validation
    f: 200,           // fraud proof checking
    u: 400,           // UTXO validation
    synced: 50,       // up to date with tip
    relays: 25,       // connected to relays
    contributing: 75, // uploading blocks to R2
  },
}

// Recipes — preset configurations
export const RECIPES = {
  phone: {
    label: 'Phone',
    description: 'Headers + last 12 blocks',
    retention: 12,
    htfu: { h: true, t: false, f: false, u: false },
    score: 100,
  },
  wallet: {
    label: 'Wallet',
    description: 'Verify your own transactions',
    retention: 100,
    htfu: { h: true, t: true, f: false, u: false },
    score: 400,
  },
  power: {
    label: 'Power',
    description: 'Catch fraud, validate blocks',
    retention: 2016,
    htfu: { h: true, t: true, f: true, u: false },
    score: 600,
  },
  full: {
    label: 'Full',
    description: 'Full rolling validation',
    retention: 4032,
    htfu: { h: true, t: true, f: true, u: true },
    score: 1000,
  },
  archive: {
    label: 'Archive',
    description: 'Keep everything, serve the network',
    retention: -1,
    htfu: { h: true, t: true, f: true, u: true },
    contributeBlocks: true,
    score: 1000,
  },
}

// Compute node score from config
export function computeScore(config, state = {}) {
  const weights = config.scoring || DEFAULTS.scoring
  let score = 0

  if (config.htfu?.h) score += weights.h
  if (config.htfu?.t) score += weights.t
  if (config.htfu?.f) score += weights.f
  if (config.htfu?.u) score += weights.u
  if (state.synced) score += weights.synced
  if (state.relaysConnected) score += weights.relays
  if (config.contributeBlocks) score += weights.contributing

  return Math.min(1000, score)
}

// Merge user overrides with defaults
export function mergeConfig(userConfig) {
  return {
    ...DEFAULTS,
    ...userConfig,
    htfu: { ...DEFAULTS.htfu, ...(userConfig?.htfu || {}) },
    sources: userConfig?.sources || DEFAULTS.sources,
    relays: userConfig?.relays || DEFAULTS.relays,
    r2: { ...DEFAULTS.r2, ...(userConfig?.r2 || {}) },
    scoring: { ...DEFAULTS.scoring, ...(userConfig?.scoring || {}) },
  }
}
