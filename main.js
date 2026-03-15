// Electron main process — thin wrapper around the web app
// Falls back gracefully: if Electron isn't installed, the app runs as pure web

import { app, BrowserWindow } from 'electron'

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    title: 'Bitcoin Desktop',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  })

  win.loadFile('index.html')
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
