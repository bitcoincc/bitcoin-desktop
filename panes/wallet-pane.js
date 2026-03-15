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

    // Check for existing wallet
    const btc = window._btc || {}
    const chain = btc.chain || 'btc'

    async function loadOrCreateWallet() {
      const { schnorr } = await import('https://esm.sh/@noble/curves@1.8.2/secp256k1')
      const { generateMnemonic, mnemonicToSeedSync } = await import('https://esm.sh/@scure/bip39@1.5.4')
      const { HDKey } = await import('https://esm.sh/@scure/bip32@1.6.2')
      const { bech32m } = await import('https://esm.sh/@scure/base@1.2.4')

      // Try to load existing
      let walletData = null
      if (btc.app && btc.app.storage) {
        try {
          const fs = require('fs')
          const path = require('path')
          const walletFile = path.join(btc.app.storage.basePath, 'wallet', 'keys.json')
          if (fs.existsSync(walletFile)) {
            walletData = JSON.parse(fs.readFileSync(walletFile, 'utf8'))
            mnemonic = walletData.mnemonic
          }
        } catch {}
      }

      // Generate new if none exists
      if (!mnemonic) {
        const { wordlist } = await import('https://esm.sh/@scure/bip39@1.5.4/wordlists/english')
        mnemonic = generateMnemonic(wordlist, 128) // 12 words
      }

      // Derive taproot key
      const seed = mnemonicToSeedSync(mnemonic)
      const root = HDKey.fromMasterSeed(seed)

      // BIP86: m/86'/0'/0'/0/0 (mainnet) or m/86'/1'/0'/0/0 (testnet)
      const coinType = chain === 'btc' ? 0 : 1
      const path = `m/86'/${coinType}'/0'/0/0`
      const child = root.derive(path)
      privateKey = child.privateKey

      // x-only pubkey (drop first byte)
      const fullPubkey = schnorr.getPublicKey(privateKey)
      const xOnlyPubkey = fullPubkey // schnorr.getPublicKey already returns x-only (32 bytes)

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

        // Seed card (collapsible)
        const seedCard = document.createElement('div')
        seedCard.className = 'wallet-card'

        const seedDetails = document.createElement('details')
        const seedSummary = document.createElement('summary')
        seedSummary.style.cssText = 'cursor:pointer;color:#f7931a;font-weight:600;font-size:1rem;'
        seedSummary.textContent = 'Seed Phrase'
        seedDetails.appendChild(seedSummary)

        const warning = document.createElement('div')
        warning.className = 'wallet-warning'
        warning.textContent = 'Never share your seed phrase. Anyone with these words can steal your funds.'
        seedDetails.appendChild(warning)

        const mnemonicEl = document.createElement('div')
        mnemonicEl.className = 'wallet-mnemonic'
        mnemonic.split(' ').forEach((word, i) => {
          const span = document.createElement('span')
          span.textContent = (i + 1) + '.' + word + '  '
          span.style.color = '#555'
          mnemonicEl.appendChild(span)
        })
        seedDetails.appendChild(mnemonicEl)

        seedCard.appendChild(seedDetails)
        pane.appendChild(seedCard)

        // Save wallet
        await saveWallet()

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
            await init()
          }
        })
        actionsCard.appendChild(newBtn)

        const refreshBtn = document.createElement('button')
        refreshBtn.className = 'wallet-btn secondary'
        refreshBtn.textContent = 'Refresh Balance'
        refreshBtn.addEventListener('click', async () => {
          balanceEl.textContent = '...'
          const bal = await checkBalance()
          if (bal) {
            balanceEl.textContent = bal.total.toLocaleString()
            balanceEl.style.color = '#f7931a'
          }
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
