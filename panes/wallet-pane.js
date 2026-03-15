export default {
  label: 'Wallet',
  icon: '\u{1F4B0}',

  canHandle(subject, store) {
    const node = store.get(subject.value)
    const type = store.type(node)
    return type && type.includes('Action')
  },

  render(subject, store, container) {
    const style = document.createElement('style')
    style.textContent = `
      .wallet-pane { font-family: Georgia, 'Times New Roman', serif; max-width: 720px; margin: 0 auto; padding: 1rem; }
      .wallet-title { font-size: 1.5rem; margin-bottom: 0.5rem; }
      .wallet-subtitle { color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }
      .wallet-card { padding: 1.5rem; border: 1px solid #eee; border-radius: 4px; margin: 1rem 0; }
      .wallet-card h3 { font-size: 1rem; margin-bottom: 0.75rem; color: #f7931a; }
      .wallet-mnemonic { font-family: monospace; font-size: 0.85rem; line-height: 2; background: #f5f4f0; padding: 1rem; border-radius: 4px; word-spacing: 0.5rem; margin: 0.75rem 0; }
      .wallet-warning { font-size: 0.8rem; color: #c0392b; margin: 0.5rem 0; font-style: italic; }
      .wallet-address { font-family: monospace; font-size: 0.85rem; word-break: break-all; background: #f5f4f0; padding: 0.75rem; border-radius: 4px; margin: 0.5rem 0; }
      .wallet-balance { font-size: 2rem; font-weight: bold; color: #f7931a; }
      .wallet-balance-label { font-size: 0.8rem; color: #888; }
      .wallet-btn { background: #f7931a; color: #fff; border: none; padding: 0.5rem 1.25rem; border-radius: 4px; cursor: pointer; font-size: 0.9rem; font-family: inherit; margin-right: 0.5rem; }
      .wallet-btn:hover { background: #e8850f; }
      .wallet-btn.secondary { background: none; border: 1px solid #ddd; color: #666; }
      .wallet-btn.secondary:hover { border-color: #f7931a; color: #f7931a; }
      .wallet-info { font-size: 0.8rem; color: #888; margin: 0.5rem 0; }
      .wallet-path { font-family: monospace; font-size: 0.75rem; color: #888; }
      .wallet-btn:disabled { background: #ccc; cursor: not-allowed; }
    `
    container.appendChild(style)

    const pane = document.createElement('div')
    pane.className = 'wallet-pane'
    container.appendChild(pane)

    const title = document.createElement('div')
    title.className = 'wallet-title'
    title.textContent = 'Wallet'
    pane.appendChild(title)

    const subtitle = document.createElement('div')
    subtitle.className = 'wallet-subtitle'
    subtitle.textContent = 'Taproot (P2TR) — BIP86 key-path spend'
    pane.appendChild(subtitle)

    // State
    let mnemonic = null
    let address = null
    let privateKey = null
    let crypto = {} // holds schnorr, secp256k1, sha256, bech32m

    // Check for existing wallet
    const btc = window._btc || {}
    const chain = btc.chain || 'btc'

    async function loadOrCreateWallet() {
      const curves = await import('https://esm.sh/@noble/curves@1.8.2/secp256k1')
      const hashes = await import('https://esm.sh/@noble/hashes@1.7.2/sha256')
      const { generateMnemonic, mnemonicToSeedSync } = await import('https://esm.sh/@scure/bip39@1.5.4')
      const { HDKey } = await import('https://esm.sh/@scure/bip32@1.6.2')
      const { bech32m } = await import('https://esm.sh/@scure/base@1.2.4')
      const { schnorr, secp256k1 } = curves
      const { sha256 } = hashes
      crypto = { schnorr, secp256k1, sha256, bech32m }

      // Try to load existing
      let walletData = null
      if (btc.app && btc.app.storage && !privateKey) {
        try {
          const fs = require('fs')
          const path = require('path')
          const walletFile = path.join(btc.app.storage.basePath, 'wallet', 'keys.json')
          if (fs.existsSync(walletFile)) {
            walletData = JSON.parse(fs.readFileSync(walletFile, 'utf8'))
            if (walletData.mnemonic) mnemonic = walletData.mnemonic
            if (walletData.hexKey) privateKey = hexToBytes(walletData.hexKey)
          }
        } catch {}
      }

      // If we have a raw hex key (nostr-style), use it directly
      if (privateKey && !mnemonic) {
        const xOnlyPubkey = schnorr.getPublicKey(privateKey)
        const hrp = chain === 'btc' ? 'bc' : 'tb'
        const words = bech32m.toWords(xOnlyPubkey)
        address = bech32m.encode(hrp, [1, ...words])
        return { mnemonic: null, address, path: 'raw hex key' }
      }

      // Generate new mnemonic if none exists
      if (!mnemonic) {
        const { wordlist } = await import('https://esm.sh/@scure/bip39@1.5.4/wordlists/english')
        mnemonic = generateMnemonic(wordlist, 128) // 12 words
      }

      // Derive taproot key from mnemonic
      const seed = mnemonicToSeedSync(mnemonic)
      const root = HDKey.fromMasterSeed(seed)

      const coinType = chain === 'btc' ? 0 : 1
      const path = `m/86'/${coinType}'/0'/0/0`
      const child = root.derive(path)
      privateKey = child.privateKey

      // x-only pubkey for P2TR address
      const xOnlyPubkey = schnorr.getPublicKey(privateKey) // 32 bytes

      // Bech32m encode for P2TR
      const hrp = chain === 'btc' ? 'bc' : 'tb'
      const witnessVersion = 1
      const words = bech32m.toWords(xOnlyPubkey)
      address = bech32m.encode(hrp, [witnessVersion, ...words])

      return { mnemonic, address, path }
    }

    async function saveWallet() {
      if (!btc.app || !btc.app.storage || !mnemonic) return
      try {
        const fs = require('fs')
        const path = require('path')
        const walletDir = path.join(btc.app.storage.basePath, 'wallet')
        fs.mkdirSync(walletDir, { recursive: true })
        fs.writeFileSync(
          path.join(walletDir, 'keys.json'),
          JSON.stringify({ mnemonic, chain, created: new Date().toISOString() }, null, 2)
        )
      } catch (err) {
        console.error('Failed to save wallet:', err)
      }
    }

    async function checkBalance() {
      if (!address) return null
      const api = chain === 'btc'
        ? 'https://mempool.space/api'
        : 'https://mempool.space/testnet4/api'
      try {
        const res = await fetch(`${api}/address/${address}`)
        if (!res.ok) return null
        const data = await res.json()
        const confirmed = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum
        const unconfirmed = data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum
        return { confirmed, unconfirmed, total: confirmed + unconfirmed }
      } catch {
        return null
      }
    }

    // Helpers for tx building
    function hexToBytes(hex) {
      const b = new Uint8Array(hex.length / 2)
      for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.substr(i, 2), 16)
      return b
    }
    function bytesToHex(b) {
      return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')
    }
    function numberToLE(n, len) {
      const b = new Uint8Array(len)
      for (let i = 0; i < len; i++) { b[i] = Number(n & 0xffn); n >>= 8n }
      return b
    }
    function bigintToLE(n, len) {
      return numberToLE(BigInt(n), len)
    }
    function varInt(n) {
      if (n < 0xfd) return new Uint8Array([n])
      if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, n >> 8])
      return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff])
    }
    function taggedHash(tag, data) {
      const tagHash = crypto.sha256(new TextEncoder().encode(tag))
      return crypto.sha256(new Uint8Array([...tagHash, ...tagHash, ...data]))
    }
    function concat(...arrays) {
      const len = arrays.reduce((s, a) => s + a.length, 0)
      const r = new Uint8Array(len)
      let off = 0
      for (const a of arrays) { r.set(a, off); off += a.length }
      return r
    }

    function tweakPrivateKey(privKey) {
      const pubKey = crypto.secp256k1.getPublicKey(privKey, true)
      const xOnly = pubKey.slice(1)
      let pk = new Uint8Array(privKey)
      if (pubKey[0] === 0x03) {
        const n = crypto.secp256k1.CURVE.n
        const neg = n - BigInt('0x' + bytesToHex(privKey))
        pk = hexToBytes(neg.toString(16).padStart(64, '0'))
      }
      const tweak = taggedHash('TapTweak', xOnly)
      const tweaked = (BigInt('0x' + bytesToHex(pk)) + BigInt('0x' + bytesToHex(tweak))) % crypto.secp256k1.CURVE.n
      return hexToBytes(tweaked.toString(16).padStart(64, '0'))
    }

    function getTweakedPubKey() {
      const tweakedPriv = tweakPrivateKey(privateKey)
      return crypto.schnorr.getPublicKey(tweakedPriv)
    }

    function createOutputScript(addr) {
      const { bech32m } = crypto
      const decoded = bech32m.decode(addr)
      const witnessVer = decoded.words[0]
      const program = bech32m.fromWords(decoded.words.slice(1))
      return new Uint8Array([0x51, 0x20, ...program]) // OP_1 PUSH32
    }

    async function fetchUtxos() {
      const api = chain === 'btc' ? 'https://mempool.space/api' : 'https://mempool.space/testnet4/api'
      const res = await fetch(`${api}/address/${address}/utxo`)
      if (!res.ok) throw new Error('Failed to fetch UTXOs')
      return res.json()
    }

    async function buildAndSignTx(toAddress, amountSats, feeRate) {
      const utxos = await fetchUtxos()
      if (utxos.length === 0) throw new Error('No UTXOs available')

      const tweakedPubKey = getTweakedPubKey()
      const targetAmount = BigInt(amountSats)
      const sorted = [...utxos].sort((a, b) => b.value - a.value)

      const selected = []
      let totalInput = 0n
      for (const utxo of sorted) {
        selected.push(utxo)
        totalInput += BigInt(utxo.value)
        const estVbytes = 111 + (selected.length - 1) * 58
        if (totalInput >= targetAmount + BigInt(estVbytes * feeRate)) break
      }

      const vbytes = Math.ceil(10.5 + selected.length * 57.5 + 2 * 43)
      const fee = BigInt(vbytes * feeRate)
      const change = totalInput - targetAmount - fee
      if (change < 0n) throw new Error('Insufficient funds (need ' + (targetAmount + fee) + ' sats, have ' + totalInput + ')')

      const outputs = [{ address: toAddress, value: targetAmount }]
      if (change >= 330n) outputs.push({ address, value: change })

      // Build inputs
      const inputs = selected.map(utxo => ({
        txid: hexToBytes(utxo.txid).reverse(),
        vout: bigintToLE(utxo.vout, 4),
        sequence: new Uint8Array([0xfd, 0xff, 0xff, 0xff]),
        value: BigInt(utxo.value),
      }))

      // Build outputs
      const outputsData = outputs.map(out => ({
        value: bigintToLE(out.value, 8),
        script: createOutputScript(out.address),
      }))

      // Sighash precomputed values — use the x-only pubkey that's in the address
      const xOnlyPub = crypto.schnorr.getPublicKey(privateKey)
      const prevoutScript = new Uint8Array([0x51, 0x20, ...xOnlyPub])
      const version = bigintToLE(2, 4)
      const locktime = bigintToLE(0, 4)

      const hashPrevouts = crypto.sha256(concat(...inputs.map(i => concat(i.txid, i.vout))))
      const hashAmounts = crypto.sha256(concat(...inputs.map(i => bigintToLE(i.value, 8))))
      const hashScriptPubkeys = crypto.sha256(concat(...inputs.map(() => concat(new Uint8Array([prevoutScript.length]), prevoutScript))))
      const hashSequences = crypto.sha256(concat(...inputs.map(i => i.sequence)))
      const hashOutputs = crypto.sha256(concat(...outputsData.map(o => concat(o.value, new Uint8Array([o.script.length]), o.script))))

      // Sign each input with the raw private key (address uses untweaked pubkey)
      const witnesses = []
      for (let i = 0; i < inputs.length; i++) {
        const sigMsg = concat(
          new Uint8Array([0x00, 0x00]), // epoch, sighash type (DEFAULT)
          version, locktime,
          hashPrevouts, hashAmounts, hashScriptPubkeys, hashSequences, hashOutputs,
          new Uint8Array([0x00]), // spend type (no annex, no script path)
          bigintToLE(i, 4), // input index
        )
        const sighash = taggedHash('TapSighash', sigMsg)
        // Sign with raw key — no tweak since address uses untweaked pubkey
        let sigKey = new Uint8Array(privateKey)
        // Negate if y is odd (BIP340 requirement)
        const pub = crypto.secp256k1.getPublicKey(privateKey, true)
        if (pub[0] === 0x03) {
          const n = crypto.secp256k1.CURVE.n
          const neg = n - BigInt('0x' + bytesToHex(privateKey))
          sigKey = hexToBytes(neg.toString(16).padStart(64, '0'))
        }
        const sig = crypto.schnorr.sign(sighash, sigKey)
        witnesses.push(sig)
      }

      // Serialize transaction
      const marker = new Uint8Array([0x00])
      const flag = new Uint8Array([0x01])
      const parts = [version, marker, flag, varInt(inputs.length)]
      for (const inp of inputs) parts.push(inp.txid, inp.vout, new Uint8Array([0x00]), inp.sequence)
      parts.push(varInt(outputsData.length))
      for (const out of outputsData) parts.push(out.value, new Uint8Array([out.script.length]), out.script)
      for (const sig of witnesses) parts.push(new Uint8Array([0x01]), varInt(sig.length), sig)
      parts.push(locktime)

      const tx = concat(...parts)
      console.log('[wallet] tx hex:', bytesToHex(tx))
      console.log('[wallet] tx size:', tx.length, 'bytes')
      console.log('[wallet] inputs:', selected.length, 'outputs:', outputsData.length)
      console.log('[wallet] fee:', Number(fee), 'change:', Number(change))
      return { hex: bytesToHex(tx), fee: Number(fee), total: Number(totalInput), amount: amountSats }
    }

    async function broadcastTx(txHex) {
      const api = chain === 'btc' ? 'https://mempool.space/api' : 'https://mempool.space/testnet4/api'
      const res = await fetch(`${api}/tx`, { method: 'POST', body: txHex })
      const text = await res.text()
      console.log('[wallet] broadcast response:', res.status, text)
      if (!res.ok) throw new Error(text)
      return text
    }

    // Build UI
    async function init() {
      pane.innerHTML = ''
      pane.appendChild(title)
      pane.appendChild(subtitle)

      const loading = document.createElement('div')
      loading.className = 'wallet-info'
      loading.textContent = 'Loading wallet...'
      pane.appendChild(loading)

      try {
        const wallet = await loadOrCreateWallet()
        loading.remove()

        // Balance card
        const balanceCard = document.createElement('div')
        balanceCard.className = 'wallet-card'
        balanceCard.innerHTML = '<h3>Balance</h3>'

        const balanceEl = document.createElement('div')
        balanceEl.className = 'wallet-balance'
        balanceEl.textContent = '...'
        balanceCard.appendChild(balanceEl)

        const balanceLabel = document.createElement('div')
        balanceLabel.className = 'wallet-balance-label'
        balanceLabel.textContent = 'sats'
        balanceCard.appendChild(balanceLabel)

        pane.appendChild(balanceCard)

        // Transaction history
        const historyCard = document.createElement('div')
        historyCard.className = 'wallet-card'
        historyCard.innerHTML = '<h3>Activity</h3>'
        const historyEl = document.createElement('div')
        const historyEmpty = document.createElement('div')
        historyEmpty.className = 'wallet-info'
        historyEmpty.textContent = 'Watching for transactions...'
        historyEl.appendChild(historyEmpty)
        historyCard.appendChild(historyEl)
        pane.appendChild(historyCard)

        // Check balance
        const bal = await checkBalance()
        if (bal) {
          balanceEl.textContent = bal.total.toLocaleString()
          if (bal.unconfirmed !== 0) {
            balanceLabel.textContent = 'sats (' + bal.unconfirmed.toLocaleString() + ' unconfirmed)'
          }
        } else {
          balanceEl.textContent = '0'
          balanceEl.style.color = '#888'
        }

        // Receive card
        const receiveCard = document.createElement('div')
        receiveCard.className = 'wallet-card'
        receiveCard.innerHTML = '<h3>Receive</h3>'

        const addrEl = document.createElement('div')
        addrEl.className = 'wallet-address'
        addrEl.textContent = address
        receiveCard.appendChild(addrEl)

        const copyBtn = document.createElement('button')
        copyBtn.className = 'wallet-btn secondary'
        copyBtn.textContent = 'Copy Address'
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(address)
          copyBtn.textContent = 'Copied!'
          setTimeout(() => { copyBtn.textContent = 'Copy Address' }, 2000)
        })
        receiveCard.appendChild(copyBtn)

        const pathEl = document.createElement('div')
        pathEl.className = 'wallet-path'
        pathEl.textContent = wallet.path
        receiveCard.appendChild(pathEl)

        pane.appendChild(receiveCard)

        // Send card
        const sendCard = document.createElement('div')
        sendCard.className = 'wallet-card'
        sendCard.innerHTML = '<h3>Send</h3>'

        const sendForm = document.createElement('div')
        sendForm.innerHTML = `
          <div style="margin-bottom:0.75rem;">
            <div style="font-size:0.8rem;color:#888;margin-bottom:0.25rem;">To address</div>
            <input type="text" id="sendTo" placeholder="bc1p... or tb1p..." style="width:100%;font-family:monospace;font-size:0.8rem;padding:0.4rem 0.6rem;border:1px solid #ddd;border-radius:4px;">
          </div>
          <div style="margin-bottom:0.75rem;">
            <div style="font-size:0.8rem;color:#888;margin-bottom:0.25rem;">Amount (sats)</div>
            <input type="number" id="sendAmount" placeholder="1000" min="330" style="width:100%;padding:0.4rem 0.6rem;border:1px solid #ddd;border-radius:4px;font-family:inherit;">
          </div>
          <div style="margin-bottom:0.75rem;">
            <div style="font-size:0.8rem;color:#888;margin-bottom:0.25rem;">Fee rate (sat/vB)</div>
            <input type="number" id="sendFeeRate" value="2" min="1" style="width:80px;padding:0.4rem 0.6rem;border:1px solid #ddd;border-radius:4px;font-family:inherit;">
          </div>
        `
        sendCard.appendChild(sendForm)

        const sendBtn = document.createElement('button')
        sendBtn.className = 'wallet-btn'
        sendBtn.textContent = 'Send'
        sendCard.appendChild(sendBtn)

        const sendStatus = document.createElement('div')
        sendStatus.style.cssText = 'margin-top:0.75rem;font-size:0.85rem;'
        sendCard.appendChild(sendStatus)

        sendBtn.addEventListener('click', async () => {
          const to = pane.querySelector('#sendTo').value.trim()
          const amount = parseInt(pane.querySelector('#sendAmount').value)
          const feeRate = parseInt(pane.querySelector('#sendFeeRate').value) || 2

          if (!to || !amount || amount < 330) {
            sendStatus.textContent = 'Enter a valid address and amount (min 330 sats)'
            sendStatus.style.color = '#c0392b'
            return
          }

          sendBtn.disabled = true
          sendBtn.textContent = 'Building tx...'
          sendStatus.textContent = ''

          try {
            const tx = await buildAndSignTx(to, amount, feeRate)
            sendStatus.innerHTML = 'Fee: ' + tx.fee + ' sats<br>'
            sendBtn.textContent = 'Broadcast'
            sendBtn.disabled = false

            // Replace click to broadcast
            sendBtn.onclick = async () => {
              sendBtn.disabled = true
              sendBtn.textContent = 'Broadcasting...'
              try {
                const txid = await broadcastTx(tx.hex)
                sendStatus.innerHTML = '<span style="color:#2d8a4e">\u2713 Sent!</span><br><span style="font-family:monospace;font-size:0.75rem;word-break:break-all;">' + txid + '</span>'
                sendBtn.textContent = 'Send'
                sendBtn.disabled = false
                sendBtn.onclick = null // reset
              } catch (err) {
                sendStatus.innerHTML = '<span style="color:#c0392b">\u2717 ' + err.message + '</span>'
                sendBtn.textContent = 'Retry Broadcast'
                sendBtn.disabled = false
              }
            }
          } catch (err) {
            sendStatus.innerHTML = '<span style="color:#c0392b">\u2717 ' + err.message + '</span>'
            sendBtn.textContent = 'Send'
            sendBtn.disabled = false
          }
        })

        pane.appendChild(sendCard)

        // Seed card (collapsible)
        const seedCard = document.createElement('div')
        seedCard.className = 'wallet-card'

        const seedDetails = document.createElement('details')
        const seedSummary = document.createElement('summary')
        seedSummary.style.cssText = 'cursor:pointer;color:#f7931a;font-weight:600;font-size:1rem;'
        seedSummary.textContent = mnemonic ? 'Seed Phrase' : 'Private Key'
        seedDetails.appendChild(seedSummary)

        const warning = document.createElement('div')
        warning.className = 'wallet-warning'
        warning.textContent = mnemonic
          ? 'Never share your seed phrase. Anyone with these words can steal your funds.'
          : 'Never share your private key. Anyone with this key can steal your funds.'
        seedDetails.appendChild(warning)

        const mnemonicEl = document.createElement('div')
        mnemonicEl.className = 'wallet-mnemonic'
        if (mnemonic) {
          mnemonic.split(' ').forEach((word, i) => {
            const span = document.createElement('span')
            span.textContent = (i + 1) + '.' + word + '  '
            span.style.color = '#555'
            mnemonicEl.appendChild(span)
          })
        } else {
          mnemonicEl.textContent = bytesToHex(privateKey)
        }
        seedDetails.appendChild(mnemonicEl)

        seedCard.appendChild(seedDetails)
        pane.appendChild(seedCard)

        // Save wallet
        await saveWallet()

        // Register address for scanning
        if (btc.app) {
          const xPub = crypto.schnorr.getPublicKey(privateKey)
          const scriptPubkey = bytesToHex(new Uint8Array([0x51, 0x20, ...xPub]))
          btc.app.watchAddress(address, scriptPubkey)

          // Listen for wallet events
          btc.app.addEventListener('wallet-tx', (e) => {
            for (const evt of e.detail.events) {
              const sign = evt.type === 'receive' ? '+' : '-'
              const line = document.createElement('div')
              line.style.cssText = 'font-size:0.85rem;padding:0.5rem 0;border-bottom:1px solid #eee;'
              line.innerHTML = '<span style="color:' + (evt.type === 'receive' ? '#2d8a4e' : '#c0392b') + ';font-weight:600;">' + sign + evt.value.toLocaleString() + ' sats</span> <span style="color:#888;">block ' + evt.height + '</span>'
              historyEl.prepend(line)
            }
            // Refresh balance
            checkBalance().then(bal => {
              if (bal) {
                balanceEl.textContent = bal.total.toLocaleString()
                balanceLabel.textContent = bal.unconfirmed ? 'sats (' + bal.unconfirmed.toLocaleString() + ' unconfirmed)' : 'sats'
              }
            })
          })

          btc.app.addEventListener('wallet-mempool', (e) => {
            const bal = e.detail.balance
            balanceEl.textContent = (bal.confirmed + bal.unconfirmed).toLocaleString()
            balanceEl.style.color = '#f7931a'
            balanceLabel.textContent = bal.unconfirmed ? 'sats (' + bal.unconfirmed.toLocaleString() + ' unconfirmed)' : 'sats'
          })
        }

        // Actions
        const actionsCard = document.createElement('div')
        actionsCard.className = 'wallet-card'
        actionsCard.innerHTML = '<h3>Actions</h3>'

        const newBtn = document.createElement('button')
        newBtn.className = 'wallet-btn secondary'
        newBtn.textContent = 'New Wallet'
        newBtn.addEventListener('click', async () => {
          if (confirm('This will replace your current wallet. Make sure you have backed up your seed phrase!')) {
            mnemonic = null
            address = null
            privateKey = null
            await init()
          }
        })
        actionsCard.appendChild(newBtn)

        // Restore wallet
        const restoreCard = document.createElement('div')
        restoreCard.className = 'wallet-card'
        restoreCard.innerHTML = '<h3>Import Wallet</h3>'
        const restoreInput = document.createElement('input')
        restoreInput.type = 'text'
        restoreInput.placeholder = '12-word seed phrase or 64-char hex key (Nostr compatible)'
        restoreInput.style.cssText = 'width:100%;font-family:monospace;font-size:0.8rem;padding:0.5rem;border:1px solid #ddd;border-radius:4px;margin-bottom:0.5rem;'
        restoreCard.appendChild(restoreInput)
        const restoreStatus = document.createElement('div')
        restoreStatus.style.cssText = 'font-size:0.8rem;margin-bottom:0.5rem;min-height:1.2em;'
        restoreCard.appendChild(restoreStatus)
        const restoreBtn = document.createElement('button')
        restoreBtn.className = 'wallet-btn'
        restoreBtn.textContent = 'Import'
        restoreCard.appendChild(restoreBtn)
        pane.appendChild(restoreCard)

        restoreBtn.addEventListener('click', async () => {
          const input = restoreInput.value.trim()
          if (!input) { restoreStatus.textContent = 'Enter a seed phrase or hex key'; restoreStatus.style.color = '#c0392b'; return }

          restoreBtn.disabled = true
          restoreBtn.textContent = 'Importing...'
          restoreStatus.textContent = ''

          try {
            let saveData = {}

            if (/^[0-9a-fA-F]{64}$/.test(input)) {
              // Hex private key
              privateKey = hexToBytes(input)
              mnemonic = null
              address = null
              saveData = { hexKey: input, chain, created: new Date().toISOString() }
              restoreStatus.textContent = 'Hex key detected'
              restoreStatus.style.color = '#2d8a4e'
            } else {
              const words = input.toLowerCase().split(/\s+/).filter(w => w.length > 0)
              if (words.length === 12 || words.length === 24) {
                mnemonic = words.join(' ')
                privateKey = null
                address = null
                saveData = { mnemonic, chain, created: new Date().toISOString() }
                restoreStatus.textContent = words.length + '-word seed detected'
                restoreStatus.style.color = '#2d8a4e'
              } else {
                restoreStatus.textContent = 'Invalid: need 12/24 words or 64 hex chars'
                restoreStatus.style.color = '#c0392b'
                restoreBtn.disabled = false
                restoreBtn.textContent = 'Import'
                return
              }
            }

            // Save to disk
            try {
              const fs = require('fs')
              const path = require('path')
              const walletDir = path.join(btc.app.storage.basePath, 'wallet')
              fs.mkdirSync(walletDir, { recursive: true })
              fs.writeFileSync(path.join(walletDir, 'keys.json'), JSON.stringify(saveData, null, 2))
            } catch {}

            restoreStatus.textContent = '\u2713 Wallet imported!'
            restoreStatus.style.color = '#2d8a4e'

            // Reinitialize
            await new Promise(r => setTimeout(r, 500))
            await init()
          } catch (err) {
            restoreStatus.textContent = 'Error: ' + err.message
            restoreStatus.style.color = '#c0392b'
            restoreBtn.disabled = false
            restoreBtn.textContent = 'Import'
          }
        })

        const refreshBtn = document.createElement('button')
        refreshBtn.className = 'wallet-btn secondary'
        refreshBtn.textContent = 'Refresh Balance'
        refreshBtn.addEventListener('click', async () => {
          balanceEl.textContent = '...'
          const bal = await checkBalance()
          if (bal) {
            balanceEl.textContent = bal.total.toLocaleString()
            balanceEl.style.color = '#f7931a'
            balanceLabel.textContent = bal.unconfirmed ? 'sats (' + bal.unconfirmed.toLocaleString() + ' unconfirmed)' : 'sats'
          }
          // Also check mempool via scanner
          if (btc.app) btc.app.scanner.checkMempool().catch(() => {})
        })
        actionsCard.appendChild(refreshBtn)

        pane.appendChild(actionsCard)

      } catch (err) {
        loading.textContent = 'Error: ' + err.message
        loading.style.color = '#c0392b'
        console.error('Wallet error:', err)
      }
    }

    init()
  }
}
