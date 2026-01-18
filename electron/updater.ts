/**
 * 自动更新模块
 * 使用 electron-updater 实现检测 -> 下载 -> 提示重启 -> 完成更新的全自动化流程
 */

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { app, dialog } = require('electron')
import type { BrowserWindow as BrowserWindowType } from 'electron'

// 动态导入 electron-updater，避免开发环境报错
let autoUpdater: any = null

export async function initAutoUpdater(getMainWindow: () => BrowserWindowType | null) {
  // 仅在生产环境启用自动更新
  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    return
  }

  try {
    const { autoUpdater: updater } = require('electron-updater')
    autoUpdater = updater

    // 配置自动更新
    autoUpdater.autoDownload = false // 不自动下载，让用户确认
    autoUpdater.autoInstallOnAppQuit = true // 退出时自动安装

    // 检查更新时
    autoUpdater.on('checking-for-update', () => {
    })

    // 有可用更新
    autoUpdater.on('update-available', (info: any) => {

      const mainWindow = getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: '发现新版本',
          message: `发现新版本 v${info.version}`,
          detail: '是否立即下载更新？下载完成后将在下次启动时自动安装。',
          buttons: ['立即下载', '稍后提醒'],
          defaultId: 0,
          cancelId: 1
        }).then((result: any) => {
          if (result.response === 0) {
            autoUpdater.downloadUpdate()
          }
        })
      }
    })

    // 没有可用更新
    autoUpdater.on('update-not-available', () => {
    })

    // 下载进度
    autoUpdater.on('download-progress', (progress: any) => {

      const mainWindow = getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setProgressBar(progress.percent / 100)
      }
    })

    // 下载完成
    autoUpdater.on('update-downloaded', (info: any) => {

      const mainWindow = getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setProgressBar(-1) // 清除进度条

        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: '更新已就绪',
          message: `新版本 v${info.version} 已下载完成`,
          detail: '是否立即重启应用以完成更新？',
          buttons: ['立即重启', '稍后重启'],
          defaultId: 0,
          cancelId: 1
        }).then((result: any) => {
          if (result.response === 0) {
            autoUpdater.quitAndInstall(false, true)
          }
        })
      }
    })

    // 更新错误
    autoUpdater.on('error', (error: Error) => {
      console.error('[AutoUpdater] 更新出错:', error.message)
    })

    // 延迟检查更新，避免影响启动速度
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err: Error) => {
        console.error('[AutoUpdater] 检查更新失败:', err.message)
      })
    }, 5000)

  } catch (error) {
    console.error('[AutoUpdater] 初始化失败:', error)
  }
}

// 手动检查更新
export function checkForUpdates() {
  if (autoUpdater) {
    autoUpdater.checkForUpdates().catch((err: Error) => {
      console.error('[AutoUpdater] 检查更新失败:', err.message)
    })
  }
}
