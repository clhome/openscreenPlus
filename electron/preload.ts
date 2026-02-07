import electron from 'electron'
const { contextBridge, ipcRenderer } = electron

contextBridge.exposeInMainWorld('electronAPI', {
  ipcRenderer: {
    send: (channel: string, ...args: any[]) => {
      ipcRenderer.send(channel, ...args);
    },
  },
  hudOverlayHide: () => {
    ipcRenderer.send('hud-overlay-hide');
  },
  hudOverlayClose: () => {
    ipcRenderer.send('hud-overlay-close');
  },
  resizeOverlay: (width: number, height: number) => {
    return ipcRenderer.invoke('resize-overlay', width, height);
  },
  // 设置鼠标事件穿透
  setIgnoreMouseEvents: (ignore: boolean, options?: { forward: boolean }) => {
    ipcRenderer.send('set-ignore-mouse-events', ignore, options);
  },
  getAssetBasePath: async () => {
    // ask main process for the correct base path (production vs dev)
    return await ipcRenderer.invoke('get-asset-base-path')
  },
  getSources: async (opts: Electron.SourcesOptions) => {
    return await ipcRenderer.invoke('get-sources', opts)
  },
  switchToEditor: () => {
    return ipcRenderer.invoke('switch-to-editor')
  },
  openSourceSelector: () => {
    return ipcRenderer.invoke('open-source-selector')
  },
  selectSource: (source: any) => {
    return ipcRenderer.invoke('select-source', source)
  },
  getSelectedSource: () => {
    return ipcRenderer.invoke('get-selected-source')
  },

  storeRecordedVideo: (videoData: ArrayBuffer, fileName: string) => {
    return ipcRenderer.invoke('store-recorded-video', videoData, fileName)
  },

  getRecordedVideoPath: () => {
    return ipcRenderer.invoke('get-recorded-video-path')
  },
  setRecordingState: (recording: boolean) => {
    return ipcRenderer.invoke('set-recording-state', recording)
  },
  onStopRecordingFromTray: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('stop-recording-from-tray', listener)
    return () => ipcRenderer.removeListener('stop-recording-from-tray', listener)
  },
  // 暂停录制事件监听
  onPauseRecordingFromTray: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('pause-recording-from-tray', listener)
    return () => ipcRenderer.removeListener('pause-recording-from-tray', listener)
  },
  // 全局快捷键事件监听
  onGlobalShortcut: (callback: (action: string) => void) => {
    const listener = (_event: any, action: string) => callback(action)
    ipcRenderer.on('global-shortcut', listener)
    return () => ipcRenderer.removeListener('global-shortcut', listener)
  },
  // 快捷键设置
  getShortcutSettings: () => {
    return ipcRenderer.invoke('get-shortcut-settings')
  },
  setShortcutSettings: (settings: any) => {
    return ipcRenderer.invoke('set-shortcut-settings', settings)
  },
  openExternalUrl: (url: string) => {
    return ipcRenderer.invoke('open-external-url', url)
  },
  saveExportedVideo: (videoData: ArrayBuffer, fileName: string) => {
    return ipcRenderer.invoke('save-exported-video', videoData, fileName)
  },
  openVideoFilePicker: () => {
    return ipcRenderer.invoke('open-video-file-picker')
  },
  setCurrentVideoPath: (path: string) => {
    return ipcRenderer.invoke('set-current-video-path', path)
  },
  getCurrentVideoPath: () => {
    return ipcRenderer.invoke('get-current-video-path')
  },
  clearCurrentVideoPath: () => {
    return ipcRenderer.invoke('clear-current-video-path')
  },
  getPlatform: () => {
    return ipcRenderer.invoke('get-platform')
  },
  getMouseData: (videoPath: string) => {
    return ipcRenderer.invoke('get-mouse-data', videoPath)
  },
  // 倒计时窗口
  showCountdown: () => {
    return ipcRenderer.invoke('show-countdown')
  },
  closeCountdown: () => {
    return ipcRenderer.invoke('close-countdown')
  },
  // 倒计时完成事件监听（由倒计时窗口发送，HUD 窗口接收）
  onCountdownComplete: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('countdown-complete', listener)
    return () => ipcRenderer.removeListener('countdown-complete', listener)
  },
  // 倒计时取消事件监听
  onCountdownCancelled: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('countdown-cancelled', listener)
    return () => ipcRenderer.removeListener('countdown-cancelled', listener)
  },
  // 倒计时窗口用：发送完成事件
  sendCountdownComplete: () => {
    ipcRenderer.send('countdown-complete-from-window')
  },
  // 倒计时窗口用：发送取消事件
  sendCountdownCancelled: () => {
    ipcRenderer.send('countdown-cancelled-from-window')
  },
})