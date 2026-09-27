/**
 * 启动页与主进程之间**唯一**的通道。
 *
 * 为什么要有它：启动页需要「重试 / 看日志 / 退出」三个按钮，而窗口本身
 * 是加载**桥接伺服的那个界面**（`config-ui/dist`）—— 那份产物不需要任何特权。
 * 所以这里只开一个通道、只认四个白名单动作，窗口拿不到 `require`、
 * 拿不到文件系统、也拿不到任意 IPC 频道。
 *
 * ⚠️ 白名单**必须**在主进程侧再判一次（main.cjs 的 `desktop:action`）：
 *   只靠这里过滤等于把"白名单"变成"文档里的一句话"。
 */

'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const ALLOWED = new Set(['start', 'stop', 'restart', 'retry', 'logs', 'quit'])

contextBridge.exposeInMainWorld('interactbot', {
  /** 启动页订阅启动进度。回调收到的都是纯 JSON（见 main.cjs 的 sendSplash）。 */
  onProgress (callback) {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('splash', listener)
    return () => ipcRenderer.removeListener('splash', listener)
  },
  /** 请求一个动作。返回 `{ok, message}`；不认识的动作一律拒绝。 */
  act (action) {
    if (!ALLOWED.has(action)) return Promise.resolve({ ok: false, message: `不允许的动作：${action}` })
    return ipcRenderer.invoke('desktop:action', action)
  },
})
