/**
 * JSS (JavaScript Solid Server) block source
 * Fetches blocks from the local Solid server
 * Fast, no rate limits, serves from ~/.bitcoin-desktop/
 */

const EPOCH_SIZE = 2016

export default {
  name: 'jss',
  label: 'Local Solid Server',
  browser: true,
  desktop: true,
  _port: 8443,

  setPort(port) {
    this._port = port
  },

  async fetchBlock(height, hash, chain) {
    const epoch = Math.floor(height / EPOCH_SIZE)
    const url = `http://localhost:${this._port}/${chain}/blocks/${epoch}/${height}.bin`
    try {
      const res = await fetch(url)
      if (!res.ok) return null
      return new Uint8Array(await res.arrayBuffer())
    } catch {
      return null
    }
  }
}
