/**
 * Blockstream.info (Esplora) block source
 * Free API, responses cacheable
 */

const APIS = {
  btc: 'https://blockstream.info/api',
  tbtc4: 'https://mempool.space/testnet4/api',
}

function nodeHttpGet(url) {
  const https = require('https')
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept-Encoding': 'identity' } }, (res) => {
      if (res.statusCode !== 200) { resolve(null); return }
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', () => resolve(null))
    }).on('error', () => resolve(null))
  })
}

export default {
  name: 'blockstream',
  label: 'Blockstream.info',
  browser: true,
  desktop: true,

  async fetchBlock(height, hash, chain) {
    const api = APIS[chain] || APIS.btc
    const url = `${api}/block/${hash}/raw`

    try {
      // Use Node.js https if available (Electron) — avoids fetch compression issues
      if (typeof require !== 'undefined') {
        const buf = await nodeHttpGet(url)
        if (!buf || buf.length < 80) return null
        console.log('[blockstream] node https:', buf.length, 'bytes')
        return new Uint8Array(buf)
      }

      // Browser fallback
      const res = await fetch(url)
      if (!res.ok) return null
      return new Uint8Array(await res.arrayBuffer())
    } catch {
      return null
    }
  }
}
