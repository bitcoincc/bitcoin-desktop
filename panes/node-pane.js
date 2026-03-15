export default {
  label: 'Node',
  icon: '\u26D3',

  canHandle(subject, store) {
    const node = store.get(subject.value)
    const type = store.type(node)
    return type && type.includes('Action')
  },

  render(subject, store, container) {
    const COST_PER_EH = 0.833

    const style = document.createElement('style')
    style.textContent = `
      .node-pane { font-family: Georgia, 'Times New Roman', serif; max-width: 720px; margin: 0 auto; padding: 1rem; }
      .node-title { font-size: 1.5rem; font-weight: 400; margin-bottom: 0.25rem; }
      .node-title span { color: #f7931a; }
      .node-subtitle { color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }
      .chain-select { margin-bottom: 1rem; }
      .chain-select button { background: none; border: 1px solid #ddd; padding: 0.4rem 1rem; border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 0.85rem; margin-right: 0.5rem; color: #666; }
      .chain-select button.active { background: #f7931a; color: #fff; border-color: #f7931a; }
      .start-btn { background: #f7931a; color: #fff; border: none; padding: 0.6rem 1.5rem; border-radius: 4px; cursor: pointer; font-size: 1rem; font-family: inherit; }
      .start-btn:hover { background: #e8850f; }
      .start-btn:disabled { background: #ccc; cursor: not-allowed; }
      .node-status { margin: 1rem 0; padding: 1rem; border: 1px solid #eee; border-radius: 4px; }
      .phase { margin: 1rem 0; padding: 1rem; border: 1px solid #eee; border-radius: 4px; }
      .phase-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
      .phase-title { font-weight: 600; }
      .phase-badge { font-size: 0.7rem; padding: 0.2rem 0.6rem; border-radius: 3px; }
      .badge-pending { background: #f5f4f0; color: #888; }
      .badge-running { background: #fff3e0; color: #f7931a; }
      .badge-done { background: rgba(45, 138, 78, 0.1); color: #2d8a4e; }
      .badge-error { background: rgba(192, 57, 43, 0.1); color: #c0392b; }
      .phase-detail { font-size: 0.85rem; color: #666; }
      .bar { height: 4px; background: #eee; border-radius: 2px; margin-top: 0.5rem; overflow: hidden; }
      .bar-fill { height: 100%; background: #f7931a; border-radius: 2px; transition: width 0.2s; width: 0%; }
      .result { font-size: 1.1rem; font-weight: bold; margin: 1.5rem 0; padding: 1rem; border-radius: 4px; }
      .result.pass { background: rgba(45, 138, 78, 0.1); color: #2d8a4e; border: 1px solid rgba(45, 138, 78, 0.3); }
      .live-stats { margin: 1rem 0; padding: 1rem; background: linear-gradient(135deg, #fdf6ec 0%, #fafaf8 100%); border: 1px solid #f7931a33; border-radius: 4px; }
      .live-stats-title { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin-bottom: 0.75rem; }
      .live-stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.75rem 1rem; }
      .stat-value { font-size: 1.1rem; font-weight: bold; }
      .stat-value .unit { font-size: 0.75rem; font-weight: normal; color: #888; }
      .stat-label { font-size: 0.7rem; color: #888; }
      .htfu-table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; font-size: 0.85rem; }
      .htfu-table th { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 2px solid #ddd; color: #888; font-weight: 500; }
      .htfu-table td { padding: 0.5rem 0.75rem; border-bottom: 1px solid #eee; }
      .htfu-table tr:hover td { background: #f5f4f0; }
      .htfu-badge { display: inline-block; width: 22px; height: 22px; border-radius: 3px; text-align: center; line-height: 22px; font-size: 0.7rem; font-weight: 600; color: #fff !important; background: #2d8a4e; }
      .htfu-pass { color: #2d8a4e; font-weight: bold; }
      .htfu-section td { padding-top: 1rem; font-weight: 600; color: #555; border-bottom: 1px solid #ddd; font-size: 0.8rem; }
      .htfu-evidence { font-size: 0.75rem; color: #888; }
      .verify-input { display: flex; gap: 0.5rem; margin: 1.5rem 0; align-items: center; }
      .verify-input input { flex: 1; font-family: monospace; font-size: 0.8rem; padding: 0.4rem 0.6rem; border: 1px solid #ddd; border-radius: 4px; }
      .verify-input button { white-space: nowrap; }
      .tx-result { margin: 1rem 0; padding: 1rem; border: 1px solid #eee; border-radius: 4px; }
    `
    container.appendChild(style)

    const pane = document.createElement('div')
    pane.className = 'node-pane'
    container.appendChild(pane)

    const title = document.createElement('div')
    title.className = 'node-title'
    title.innerHTML = 'bitcoin<span>.desktop</span>'
    pane.appendChild(title)

    const subtitle = document.createElement('div')
    subtitle.className = 'node-subtitle'
    subtitle.textContent = 'Full HTFU verification — headers to full node'
    pane.appendChild(subtitle)

    // Chain selector
    const chainSelect = document.createElement('div')
    chainSelect.className = 'chain-select'
    const btc = window._btc || {}
    ;['btc', 'tbtc4'].forEach(c => {
      const btn = document.createElement('button')
      btn.textContent = c === 'btc' ? 'Bitcoin' : 'Testnet4'
      btn.className = (btc.chain || 'btc') === c ? 'active' : ''
      btn.addEventListener('click', () => {
        window.location.search = c === 'btc' ? '' : '?chain=' + c
      })
      chainSelect.appendChild(btn)
    })
    pane.appendChild(chainSelect)

    // Start button
    const startBtn = document.createElement('button')
    startBtn.className = 'start-btn'
    startBtn.textContent = 'Start'
    pane.appendChild(startBtn)

    // Node status bar
    const nodeStatus = document.createElement('div')
    nodeStatus.className = 'node-status'
    nodeStatus.style.display = 'none'
    nodeStatus.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
        <div id="nodeActivity" style="font-weight:600;font-size:0.95rem;">Waiting for next block...</div>
        <div id="nodeScore" style="font-size:0.8rem;color:#888;"></div>
      </div>
      <div id="nodeDetails" style="font-size:0.8rem;color:#666;line-height:1.8;"></div>
    `
    pane.appendChild(nodeStatus)

    // Phases
    const phasesEl = document.createElement('div')
    pane.appendChild(phasesEl)

    // Live stats
    const liveStats = document.createElement('div')
    liveStats.className = 'live-stats'
    liveStats.style.display = 'none'
    liveStats.innerHTML = `
      <div class="live-stats-title">Cumulative Proof-of-Work</div>
      <div class="live-stats-grid">
        <div><div class="stat-value" id="lsDate">---</div><div class="stat-label">Block date</div></div>
        <div><div class="stat-value" id="lsHeight">0</div><div class="stat-label">Block height</div></div>
        <div><div class="stat-value" id="lsWork">0</div><div class="stat-label">Total work (log\u2082)</div></div>
        <div><div class="stat-value" id="lsHashes">0</div><div class="stat-label">Estimated hashes</div></div>
        <div><div class="stat-value" id="lsCost">$0</div><div class="stat-label">Approx. cost to reproduce</div></div>
        <div><div class="stat-value" id="lsZeros">0</div><div class="stat-label">Max leading zero bits</div></div>
      </div>
    `
    pane.appendChild(liveStats)

    const resultEl = document.createElement('div')
    pane.appendChild(resultEl)

    const htfuTable = document.createElement('table')
    htfuTable.className = 'htfu-table'
    htfuTable.style.display = 'none'
    pane.appendChild(htfuTable)

    // TX verification
    const verifySection = document.createElement('div')
    verifySection.className = 'verify-input'
    verifySection.style.display = 'none'
    verifySection.innerHTML = `
      <label style="font-size:0.75rem;color:#888;">txid:</label>
      <input type="text" id="txidInput" value="b5d750f75faefe571ede0f315a15fce8b34edfe456c94f8cc75e2868f502dd74" placeholder="Enter transaction ID to verify">
      <button class="start-btn" style="padding:0.4rem 1rem;font-size:0.85rem;" id="verifyBtn">Verify</button>
    `
    pane.appendChild(verifySection)

    const txResultEl = document.createElement('div')
    pane.appendChild(txResultEl)

    // Helpers
    function formatHashes(work) {
      if (work === 0n) return '0'
      const s = work.toString(), d = s.length
      if (d <= 6) return Number(work).toLocaleString()
      return s[0] + '.' + s.slice(1, 4) + ' \u00d7 10^' + (d - 1)
    }
    function formatDollars(n) {
      if (n >= 1e12) return '$' + (n / 1e12).toFixed(3) + ' trillion'
      if (n >= 1e9) return '$' + (n / 1e9).toFixed(3) + ' billion'
      if (n >= 1e6) return '$' + (n / 1e6).toFixed(3) + ' million'
      if (n >= 1e3) return '$' + (n / 1e3).toFixed(2) + 'K'
      return '$' + n.toFixed(0)
    }
    function timeAgo(date) {
      const s = Math.floor((Date.now() - date) / 1000)
      if (s < 5) return 'just now'
      if (s < 60) return s + 's ago'
      if (s < 3600) return Math.floor(s / 60) + 'm ago'
      return Math.floor(s / 3600) + 'h ago'
    }

    function createPhase(name) {
      const el = document.createElement('div')
      el.className = 'phase'
      el.innerHTML = `<div class="phase-header"><div class="phase-title">${name}</div><span class="phase-badge badge-pending">Pending</span></div><div class="phase-detail"></div><div class="bar"><div class="bar-fill"></div></div>`
      return el
    }

    function updateLiveStats(data) {
      if (data.date) pane.querySelector('#lsDate').textContent = data.date
      if (data.height !== undefined) pane.querySelector('#lsHeight').textContent = data.height.toLocaleString()
      if (data.work !== undefined) {
        const log2 = data.work > 0n ? (data.work.toString(2).length - 1) : 0
        pane.querySelector('#lsWork').innerHTML = '2<sup>' + log2 + '</sup> <span class="unit">hashes of work</span>'
        pane.querySelector('#lsHashes').textContent = formatHashes(data.work)
        const cost = Number(data.work / (10n ** 18n)) * COST_PER_EH
        pane.querySelector('#lsCost').textContent = formatDollars(cost)
      }
      if (data.maxZeros !== undefined) {
        pane.querySelector('#lsZeros').innerHTML = data.maxZeros + ' <span class="unit">bits (difficulty frontier)</span>'
      }
    }

    function buildHTFUTable(rules) {
      const rows = [
        { section: 'H \u2014 Header-Only (verified from 80-byte headers)' },
        { name: 'Genesis block hash matches', ...rules.genesis, evidence: 'First header \u2192 known hash' },
        { name: 'Previous block hash links correctly', ...rules.linkage, evidence: 'Adjacent headers' },
        { name: 'Proof-of-work meets difficulty target', ...rules.pow, evidence: 'Block header (80 bytes)' },
        { name: 'Difficulty retarget is correct', ...rules.retarget, evidence: 'Previous 2016 headers' },
        { name: 'Timestamp > median of previous 11', ...rules.median, evidence: 'Previous 11 headers' },
        { name: 'Block version valid for height', ...rules.version, evidence: 'Header + height' },
      ]
      let html = '<thead><tr><th>Consensus Rule</th><th></th><th>Checked</th><th>Passed</th><th>Status</th></tr></thead><tbody>'
      for (const row of rows) {
        if (row.section) { html += '<tr class="htfu-section"><td colspan="5">' + row.section + '</td></tr>'; continue }
        const pass = row.checked === row.passed
        html += '<tr><td style="font-weight:500">' + row.name + '</td><td><span class="htfu-badge">H</span></td><td>' + row.checked.toLocaleString() + '</td><td>' + row.passed.toLocaleString() + '</td><td class="' + (pass ? 'htfu-pass' : '') + '">' + (pass ? '\u2713 Pass' : '\u2717 ' + (row.checked - row.passed) + ' failures') + '</td></tr>'
        if (row.evidence) html += '<tr><td colspan="5" class="htfu-evidence">' + row.evidence + '</td></tr>'
      }
      html += '</tbody>'
      htfuTable.innerHTML = html
      htfuTable.style.display = 'table'
    }

    // State
    let lastBlockTime = null, blocksStored = 0, blocksMB = 0, relayCount = 0, relayTotal = 0
    let p1, p2, p3, p4

    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true
      startBtn.textContent = 'Running...'
      phasesEl.textContent = ''
      liveStats.style.display = 'none'
      htfuTable.style.display = 'none'
      resultEl.textContent = ''
      verifySection.style.display = 'none'
      blocksStored = 0; blocksMB = 0

      p1 = createPhase('1. Download Headers')
      p2 = createPhase('2. Verify Chain')
      p3 = createPhase('3. Nostr Live (NIP-333)')
      p4 = createPhase('4. Bootstrap Blocks')
      phasesEl.appendChild(p1)
      phasesEl.appendChild(p2)
      phasesEl.appendChild(p3)
      phasesEl.appendChild(p4)

      const { BitcoinDesktop, computeScore, config, chain } = window._btc
      const app = new BitcoinDesktop(chain, config)
      window._btc.app = app

      app.addEventListener('status', (e) => {
        const d = e.detail
        if (d.phase === 'download' && d.status === 'cached') {
          p1.querySelector('.phase-badge').textContent = '\u2713 Cached'
          p1.querySelector('.phase-badge').className = 'phase-badge badge-done'
          p1.querySelector('.phase-detail').textContent = (d.height + 1).toLocaleString() + ' headers (from cache)'
          p1.querySelector('.bar-fill').style.width = '100%'
          p1.querySelector('.bar-fill').style.background = '#2d8a4e'
        }
        if (d.phase === 'download' && d.status === 'done') {
          p1.querySelector('.phase-badge').textContent = '\u2713 Done'
          p1.querySelector('.phase-badge').className = 'phase-badge badge-done'
          p1.querySelector('.phase-detail').textContent = (d.height + 1).toLocaleString() + ' headers'
          p1.querySelector('.bar-fill').style.width = '100%'
          p1.querySelector('.bar-fill').style.background = '#2d8a4e'
        }
        if (d.phase === 'verify' && d.status === 'cached') {
          p2.querySelector('.phase-badge').textContent = '\u2713 Cached'
          p2.querySelector('.phase-badge').className = 'phase-badge badge-done'
          p2.querySelector('.phase-detail').textContent = 'Previously verified'
          p2.querySelector('.bar-fill').style.width = '100%'
          p2.querySelector('.bar-fill').style.background = '#2d8a4e'
        }
        if (d.phase === 'verify' && d.status === 'done') {
          p2.querySelector('.phase-badge').textContent = d.passed ? '\u2713 Verified' : '\u2717 Errors'
          p2.querySelector('.phase-badge').className = 'phase-badge ' + (d.passed ? 'badge-done' : 'badge-error')
          p2.querySelector('.phase-detail').textContent = 'Verified in ' + (d.elapsed || '0') + 's'
          p2.querySelector('.bar-fill').style.width = '100%'
          p2.querySelector('.bar-fill').style.background = '#2d8a4e'
          if (d.rules) buildHTFUTable(d.rules)
        }
        if (d.phase === 'nostr' && d.status === 'connecting') {
          p3.querySelector('.phase-badge').textContent = 'Connecting...'
          p3.querySelector('.phase-badge').className = 'phase-badge badge-running'
        }
        if (d.phase === 'live') {
          p3.querySelector('.phase-detail').textContent = 'Tip: block ' + d.height.toLocaleString()
          if (d.score) pane.querySelector('#nodeScore').textContent = 'Score: ' + d.score + ' / 1000'
        }
        if (d.phase === 'blocks' && d.status === 'bootstrapping') {
          p4.querySelector('.phase-badge').textContent = '0/' + d.count
          p4.querySelector('.phase-badge').className = 'phase-badge badge-running'
          p4.querySelector('.phase-detail').textContent = 'Fetching last ' + d.count + ' blocks...'
        }
        if (d.phase === 'blocks' && d.status === 'done') {
          const sizeMB = (d.totalSize / 1024 / 1024).toFixed(1)
          p4.querySelector('.phase-badge').textContent = '\u2713 ' + d.cached + ' blocks'
          p4.querySelector('.phase-badge').className = 'phase-badge badge-done'
          p4.querySelector('.phase-detail').textContent = d.cached + ' blocks cached (' + sizeMB + ' MB)'
          p4.querySelector('.bar-fill').style.width = '100%'
          p4.querySelector('.bar-fill').style.background = '#2d8a4e'
        }
        if (d.phase === 'ready') {
          p3.querySelector('.phase-badge').textContent = '\u2713 Live'
          p3.querySelector('.phase-badge').className = 'phase-badge badge-done'
          p3.querySelector('.phase-detail').textContent = 'Tip: block ' + d.height.toLocaleString()
          p3.querySelector('.bar-fill').style.width = '100%'
          p3.querySelector('.bar-fill').style.background = '#2d8a4e'

          resultEl.className = 'result pass'
          const elapsed = p2.querySelector('.phase-detail').textContent.match(/[\d.]+s/)?.[0] || ''
          resultEl.textContent = '\u2713 All H-class consensus rules passed \u2014 ' + (app.headers.height + 1).toLocaleString() + ' headers, ' + elapsed

          nodeStatus.style.display = 'block'
          pane.querySelector('#nodeScore').textContent = 'Score: ' + computeScore(config, { synced: true, relaysConnected: relayCount > 0 }) + ' / 1000'

          verifySection.style.display = 'flex'
          startBtn.textContent = 'Restart'
          startBtn.disabled = false
        }
      })

      app.addEventListener('relay', (e) => {
        relayCount = e.detail.count
        relayTotal = e.detail.total
        p3.querySelector('.phase-detail').textContent = e.detail.count + '/' + e.detail.total + ' relays connected'
        if (e.detail.count > 0) {
          p3.querySelector('.phase-badge').textContent = '\u2713 Live'
          p3.querySelector('.phase-badge').className = 'phase-badge badge-done'
          p3.querySelector('.bar-fill').style.width = '100%'
          p3.querySelector('.bar-fill').style.background = '#2d8a4e'
        }
      })

      app.addEventListener('newblock', (e) => {
        p3.querySelector('.phase-detail').textContent = 'Tip: block ' + e.detail.height.toLocaleString()
      })

      app.blocks.addEventListener('fetched', (e) => {
        if (e.detail.block) {
          app.storage.saveBlock(e.detail.height, e.detail.block).catch(() => {})
          app.uploader.upload(e.detail.height, e.detail.block).catch(() => {})
        }
        lastBlockTime = Date.now()
        blocksStored++
        blocksMB += e.detail.size / 1024 / 1024
        const target = app.config.retention || 12
        const pct = Math.min(100, (blocksStored / target * 100)).toFixed(0)
        p4.querySelector('.phase-badge').textContent = blocksStored + '/' + target
        p4.querySelector('.phase-badge').className = 'phase-badge badge-running'
        p4.querySelector('.phase-detail').textContent = blocksStored + '/' + target + ' blocks (' + blocksMB.toFixed(1) + ' MB) via ' + (e.detail.source || 'unknown')
        p4.querySelector('.bar-fill').style.width = pct + '%'

        const sizeMB = (e.detail.size / 1024 / 1024).toFixed(2)
        pane.querySelector('#nodeActivity').textContent = '\u2713 Block ' + e.detail.height.toLocaleString() + ' verified (' + sizeMB + ' MB) via ' + (e.detail.source || 'cache')
        pane.querySelector('#nodeActivity').style.color = '#2d8a4e'
        updateNodeDetails()
        setTimeout(() => {
          pane.querySelector('#nodeActivity').textContent = '\u26CF Waiting for next block...'
          pane.querySelector('#nodeActivity').style.color = '#2c2c2c'
        }, 10000)
      })

      function updateNodeDetails() {
        const ago = lastBlockTime ? timeAgo(lastBlockTime) : 'never'
        pane.querySelector('#nodeDetails').textContent =
          'Tip: ' + app.headers.height.toLocaleString() +
          ' \u00b7 ' + relayCount + '/' + relayTotal + ' relays' +
          ' \u00b7 Retention: ' + app.config.retention + ' blocks' +
          ' \u00b7 ' + blocksStored + ' cached (' + blocksMB.toFixed(1) + ' MB)' +
          ' \u00b7 Last block: ' + ago
      }

      // TX verification
      pane.querySelector('#verifyBtn').addEventListener('click', async () => {
        const txid = pane.querySelector('#txidInput').value.trim()
        if (!txid || txid.length !== 64 || !app) return
        txResultEl.textContent = ''
        try {
          const result = await app.verifyTransaction(txid)
          const el = document.createElement('div')
          el.className = 'tx-result'
          if (result.verified) {
            const date = new Date(result.timestamp * 1000).toLocaleDateString()
            el.innerHTML = '<div style="color:#2d8a4e;font-weight:bold;margin-bottom:0.5rem;">\u2713 Transaction verified</div><div style="font-size:0.85rem;color:#666;">Block ' + result.blockHeight.toLocaleString() + ' \u00b7 ' + result.confirmations + ' confirmations \u00b7 ' + date + ' \u00b7 ' + result.proofDepth + ' hash merkle proof</div>'
          } else {
            el.innerHTML = '<div style="color:#c0392b;font-weight:bold;">\u2717 Merkle proof failed</div>'
          }
          txResultEl.appendChild(el)
        } catch (err) {
          txResultEl.innerHTML = '<div class="tx-result" style="color:#c0392b;">' + err.message + '</div>'
        }
      })

      app.start((phase, done, total, extra) => {
        if (phase === 'download') {
          const pct = total ? (done / total * 100).toFixed(0) : 0
          p1.querySelector('.phase-badge').textContent = pct + '%'
          p1.querySelector('.phase-badge').className = 'phase-badge badge-running'
          p1.querySelector('.phase-detail').textContent = (done / 1024 / 1024).toFixed(1) + ' MB'
          p1.querySelector('.bar-fill').style.width = pct + '%'
        }
        if (phase === 'verify') {
          const pct = (done / total * 100).toFixed(0)
          p2.querySelector('.phase-badge').textContent = pct + '%'
          p2.querySelector('.phase-badge').className = 'phase-badge badge-running'
          p2.querySelector('.phase-detail').textContent = done.toLocaleString() + ' / ' + total.toLocaleString()
          p2.querySelector('.bar-fill').style.width = pct + '%'
          if (extra) { liveStats.style.display = 'block'; updateLiveStats(extra) }
        }
      })
    })

    // Auto-start
    setTimeout(() => startBtn.click(), 100)
  }
}
