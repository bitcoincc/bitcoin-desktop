/**
 * Blockstream.info (Esplora) block source
 * Free API, responses cacheable, rate limit ~10 req/s
 */

const APIS = {
  btc: 'https://blockstream.info/api',
  tbtc4: 'https://mempool.space/testnet4/api',
}

export default {
  name: 'blockstream',
  label: 'Blockstream.info',
  browser: true,
  desktop: true,

  async fetchBlock(height, hash, chain) {
    const api = APIS[chain] || APIS.btc
    const res = await fetch(`${api}/block/${hash}/raw`)
    if (!res.ok) return null
    return new Uint8Array(await res.arrayBuffer())
  }
}
