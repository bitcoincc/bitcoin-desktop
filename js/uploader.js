/**
 * Block uploader — contributes verified blocks to R2 via Worker proxy
 *
 * After a client fetches and verifies a block, it uploads to the CDN
 * so future clients can get it from R2 instead of P2P/APIs.
 * The CDN fills itself through usage.
 */

const WORKER_URL = 'https://block-upload.melvincarvalho.workers.dev'
const EPOCH_SIZE = 2016

export class BlockUploader {
  constructor(chain = 'btc') {
    this.chain = chain
    this.enabled = false
    this.uploaded = 0
    this.failed = 0
  }

  async upload(height, blockData) {
    if (!this.enabled) return false

    const epoch = Math.floor(height / EPOCH_SIZE)
    const key = `${this.chain}/blocks/${epoch}/${height}.bin`
    const url = `${WORKER_URL}/${key}`

    try {
      const res = await fetch(url, {
        method: 'PUT',
        body: blockData,
        headers: { 'Content-Type': 'application/octet-stream' },
      })

      if (res.ok) {
        const result = await res.json()
        if (result.status === 'uploaded') {
          this.uploaded++
          console.log(`[upload] ${key}: ${blockData.length} bytes`)
        } else if (result.status === 'exists') {
          // Already on R2, no action needed
        }
        return true
      } else {
        this.failed++
        return false
      }
    } catch (err) {
      this.failed++
      console.log('[upload] failed:', err.message)
      return false
    }
  }
}
