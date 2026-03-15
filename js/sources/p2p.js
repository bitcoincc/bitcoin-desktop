/**
 * Bitcoin P2P network block source (desktop only)
 * Connects directly to Bitcoin nodes via TCP port 8333
 * No rate limits, the authoritative source
 *
 * TODO: implement Bitcoin P2P protocol
 * - version/verack handshake
 * - getdata message for blocks
 * - block message parsing
 */

export default {
  name: 'p2p',
  label: 'Bitcoin P2P Network',
  browser: false,   // TCP not available in browser
  desktop: true,

  async fetchBlock(height, hash, chain) {
    // Not yet implemented — will connect to peers via TCP
    // and request blocks using the Bitcoin P2P protocol
    return null
  }
}
