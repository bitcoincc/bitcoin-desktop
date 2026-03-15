/**
 * Local storage block source
 * Checks ~/.bitcoin-desktop/btc/blocks/ or IndexedDB first
 * No network, instant if cached
 */

export default {
  name: 'local',
  label: 'Local cache',
  browser: true,
  desktop: true,
  _storage: null,

  setStorage(storage) {
    this._storage = storage
  },

  async fetchBlock(height, hash, chain) {
    if (!this._storage) return null
    try {
      return await this._storage.loadBlock(height)
    } catch {
      return null
    }
  }
}
