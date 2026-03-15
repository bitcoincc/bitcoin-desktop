/**
 * mempool.space block source
 * Free API, stricter rate limits than Blockstream
 */

const APIS = {
  btc: 'https://mempool.space/api',
  tbtc4: 'https://mempool.space/testnet4/api',
}

export default {
  name: 'mempool',
  label: 'mempool.space',
  browser: true,
  desktop: true,

  async fetchBlock(height, hash, chain) {
    const api = APIS[chain] || APIS.btc
    const res = await fetch(`${api}/block/${hash}/raw`)
    if (!res.ok) return null
    return new Uint8Array(await res.arrayBuffer())
  }
}
