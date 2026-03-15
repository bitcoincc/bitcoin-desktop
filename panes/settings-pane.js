export default {
  label: 'Settings',
  icon: '\u2699',

  canHandle(subject, store) {
    const node = store.get(subject.value)
    const type = store.type(node)
    return type && type.includes('Action')
  },

  render(subject, store, container) {
    const btc = window._btc || {}
    const { RECIPES, DEFAULTS, computeScore, mergeConfig } = btc
    let currentConfig = { ...btc.config }

    const style = document.createElement('style')
    style.textContent = `
      .settings-pane { font-family: Georgia, 'Times New Roman', serif; max-width: 720px; margin: 0 auto; padding: 1rem; }
      .score-display { text-align: center; padding: 1.5rem; margin: 1rem 0; background: linear-gradient(135deg, #fdf6ec 0%, #fafaf8 100%); border: 1px solid #f7931a33; border-radius: 4px; }
      .score-number { font-size: 2.5rem; font-weight: bold; color: #f7931a; }
      .score-label { font-size: 0.8rem; color: #888; }
      .score-bar { height: 8px; background: #eee; border-radius: 4px; margin-top: 0.75rem; overflow: hidden; }
      .score-fill { height: 100%; background: linear-gradient(90deg, #f7931a, #2d8a4e); border-radius: 4px; transition: width 0.3s; }
      .setting-group { margin-bottom: 1.5rem; }
      .setting-label { font-size: 0.8rem; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
      .recipes { display: flex; gap: 0.5rem; flex-wrap: wrap; }
      .recipe { padding: 0.5rem 1rem; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; font-size: 0.85rem; text-align: center; min-width: 80px; }
      .recipe:hover { border-color: #f7931a; }
      .recipe.active { background: #f7931a; color: #fff; border-color: #f7931a; }
      .recipe-score { font-size: 0.7rem; color: #888; margin-top: 0.2rem; }
      .recipe.active .recipe-score { color: rgba(255,255,255,0.8); }
      .htfu-toggles { display: flex; gap: 0.5rem; margin: 0.75rem 0; }
      .htfu-toggle { width: 44px; height: 44px; border-radius: 4px; border: 2px solid #ddd; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 1rem; cursor: pointer; }
      .htfu-toggle.on { background: #2d8a4e; color: #fff; border-color: #2d8a4e; }
      .htfu-toggle.locked { opacity: 0.5; cursor: not-allowed; }
      .setting-row { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0; border-bottom: 1px solid #eee; font-size: 0.85rem; }
      .setting-row:last-child { border-bottom: none; }
      .apply-btn { background: #f7931a; color: #fff; border: none; padding: 0.6rem 1.5rem; border-radius: 4px; cursor: pointer; font-size: 1rem; font-family: inherit; margin-top: 1rem; width: 100%; }
      .apply-btn:hover { background: #e8850f; }
    `
    container.appendChild(style)

    const pane = document.createElement('div')
    pane.className = 'settings-pane'
    container.appendChild(pane)

    // Score display
    const scoreDisplay = document.createElement('div')
    scoreDisplay.className = 'score-display'
    scoreDisplay.innerHTML = '<div class="score-number" id="sScore">0</div><div class="score-label">Node Score</div><div class="score-bar"><div class="score-fill" id="sScoreFill" style="width:0%"></div></div>'
    pane.appendChild(scoreDisplay)

    // Recipes
    const recipeGroup = document.createElement('div')
    recipeGroup.className = 'setting-group'
    recipeGroup.innerHTML = '<div class="setting-label">Recipe</div>'
    const recipesEl = document.createElement('div')
    recipesEl.className = 'recipes'
    recipeGroup.appendChild(recipesEl)
    pane.appendChild(recipeGroup)

    for (const [key, recipe] of Object.entries(RECIPES)) {
      const btn = document.createElement('div')
      btn.className = 'recipe'
      btn.dataset.recipe = key
      btn.innerHTML = '<div>' + recipe.label + '</div><div class="recipe-score">' + recipe.score + '/1000</div>'
      btn.addEventListener('click', () => {
        recipesEl.querySelectorAll('.recipe').forEach(r => r.classList.remove('active'))
        btn.classList.add('active')
        currentConfig.htfu = { ...recipe.htfu }
        currentConfig.retention = recipe.retention
        currentConfig.contributeBlocks = recipe.contributeBlocks || false
        updateUI()
      })
      recipesEl.appendChild(btn)
    }

    // HTFU toggles
    const htfuGroup = document.createElement('div')
    htfuGroup.className = 'setting-group'
    htfuGroup.innerHTML = '<div class="setting-label">Verification Level (HTFU)</div>'
    const htfuToggles = document.createElement('div')
    htfuToggles.className = 'htfu-toggles'
    htfuGroup.appendChild(htfuToggles)
    pane.appendChild(htfuGroup)

    ;['h', 't', 'f', 'u'].forEach(level => {
      const toggle = document.createElement('div')
      toggle.className = 'htfu-toggle' + (level === 'h' ? ' on locked' : '')
      toggle.textContent = level.toUpperCase()
      toggle.dataset.level = level
      if (level !== 'h') {
        toggle.addEventListener('click', () => {
          currentConfig.htfu[level] = !currentConfig.htfu[level]
          if (level === 'u' && currentConfig.htfu.u) { currentConfig.htfu.t = true; currentConfig.htfu.f = true }
          if (level === 'f' && currentConfig.htfu.f) { currentConfig.htfu.t = true }
          if (level === 't' && !currentConfig.htfu.t) { currentConfig.htfu.f = false; currentConfig.htfu.u = false }
          if (level === 'f' && !currentConfig.htfu.f) { currentConfig.htfu.u = false }
          recipesEl.querySelectorAll('.recipe').forEach(r => r.classList.remove('active'))
          updateUI()
        })
      }
      htfuToggles.appendChild(toggle)
    })

    // Retention
    const retGroup = document.createElement('div')
    retGroup.className = 'setting-group'
    retGroup.innerHTML = '<div class="setting-label">Block Retention</div><div class="setting-row"><span>Keep last</span><span><input type="number" id="sRetention" value="' + (currentConfig.retention || 12) + '" min="0" max="100000" style="width:80px;padding:0.3rem 0.5rem;border:1px solid #ddd;border-radius:4px;font-family:inherit;font-size:0.85rem;text-align:right;"> blocks</span></div>'
    pane.appendChild(retGroup)

    pane.querySelector('#sRetention').addEventListener('change', (e) => {
      currentConfig.retention = parseInt(e.target.value) || 0
      recipesEl.querySelectorAll('.recipe').forEach(r => r.classList.remove('active'))
      updateUI()
    })

    // Network
    const netGroup = document.createElement('div')
    netGroup.className = 'setting-group'
    netGroup.innerHTML = '<div class="setting-label">Network</div><div class="setting-row"><span>Contribute blocks to CDN</span><input type="checkbox" id="sContribute" ' + (currentConfig.contributeBlocks ? 'checked' : '') + '></div><div class="setting-row"><span>Block sources</span><span style="color:#555;font-weight:500;">' + (currentConfig.sources || []).join(', ') + '</span></div>'
    pane.appendChild(netGroup)

    pane.querySelector('#sContribute').addEventListener('change', (e) => {
      currentConfig.contributeBlocks = e.target.checked
      updateUI()
    })

    // Server
    const serverGroup = document.createElement('div')
    serverGroup.className = 'setting-group'
    serverGroup.innerHTML = '<div class="setting-label">Solid Server</div><div class="setting-row"><span>Serve blocks locally (JSS)</span><input type="checkbox" id="sServe" ' + (currentConfig.serveBlocks ? 'checked' : '') + '></div><div class="setting-row"><span>Port</span><input type="number" id="sPort" value="' + (currentConfig.serverPort || 8443) + '" min="1024" max="65535" style="width:80px;padding:0.3rem 0.5rem;border:1px solid #ddd;border-radius:4px;font-family:inherit;font-size:0.85rem;text-align:right;"></div>'
    pane.appendChild(serverGroup)

    pane.querySelector('#sServe').addEventListener('change', (e) => {
      currentConfig.serveBlocks = e.target.checked
      updateUI()
    })
    pane.querySelector('#sPort').addEventListener('change', (e) => {
      currentConfig.serverPort = parseInt(e.target.value) || 8443
    })

    // Apply button
    const applyBtn = document.createElement('button')
    applyBtn.className = 'apply-btn'
    applyBtn.textContent = 'Apply & Restart'
    applyBtn.addEventListener('click', async () => {
      try {
        await btc.configStorage.saveConfig(currentConfig)
        window._btc.config = currentConfig
        window.location.reload()
      } catch (err) {
        console.error('Failed to save config:', err)
      }
    })
    pane.appendChild(applyBtn)

    function updateUI() {
      // HTFU toggles
      htfuToggles.querySelectorAll('.htfu-toggle:not(.locked)').forEach(toggle => {
        toggle.classList.toggle('on', currentConfig.htfu[toggle.dataset.level])
      })
      // Retention
      pane.querySelector('#sRetention').value = currentConfig.retention
      // Contribute
      pane.querySelector('#sContribute').checked = currentConfig.contributeBlocks
      // Score
      const score = computeScore(currentConfig, { synced: true, relaysConnected: true })
      pane.querySelector('#sScore').textContent = score
      pane.querySelector('#sScoreFill').style.width = (score / 10) + '%'
    }

    updateUI()
  }
}
