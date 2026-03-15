/**
 * R2 CDN block source
 * No rate limits, our own infrastructure
 */

const R2_BASE = 'https://pub-a5a92731dd0d452b9670be07e5354fd6.r2.dev'
const EPOCH_SIZE = 2016

export default {
  name: 'r2',
  label: 'R2 CDN',
  browser: true,
  desktop: true,

  async fetchBlock(height, hash, chain) {
    const epoch = Math.floor(height / EPOCH_SIZE)
    const url = `${R2_BASE}/${chain}/blocks/${epoch}/${height}.bin`
    try {
      const res = await fetch(url)
      if (!res.ok) return null
      return new Uint8Array(await res.arrayBuffer())
    } catch {
      return null
    }
  }
}
