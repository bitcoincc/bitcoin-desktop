/**
 * Proof server — serves merkle proofs over HTTP
 *
 * GET /api/proof/:height/:txid → compute and return merkle proof
 *
 * Runs alongside JSS on a separate port (default: JSS port + 1)
 */

import { createServer } from 'http'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createSHA256 } from 'hash-wasm'
import { MerkleVerifier } from './merkle.js'

const EPOCH_SIZE = 2016

export async function startProofServer(dataDir, chain, port) {
  const hasher = await createSHA256()
  const merkle = new MerkleVerifier(hasher)

  const server = createServer((req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    // Parse: /api/proof/:height/:txid
    const match = req.url.match(/^\/api\/proof\/(\d+)\/([0-9a-f]{64})$/)
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Use: /api/proof/{height}/{txid}' }))
      return
    }

    const height = parseInt(match[1])
    const txid = match[2]
    const epoch = Math.floor(height / EPOCH_SIZE)
    const blockFile = join(dataDir, chain, 'blocks', String(epoch), height + '.bin')

    if (!existsSync(blockFile)) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Block ' + height + ' not available locally' }))
      return
    }

    try {
      const blockData = readFileSync(blockFile)
      const proof = merkle.generateProof(blockData, txid)

      if (!proof) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Transaction ' + txid + ' not found in block ' + height }))
        return
      }

      proof.block_height = height
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(proof))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  })

  server.listen(port, () => {
    console.log(`[proof] Serving merkle proofs on http://localhost:${port}/api/proof/{height}/{txid}`)
  })

  return server
}
