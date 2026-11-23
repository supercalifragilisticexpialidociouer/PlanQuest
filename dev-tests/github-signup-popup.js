/* 临时独立窗口：打开 GitHub 注册页，与 PlanQuest 应用完全无关。
 * 用 Electron 单独起一个干净窗口（隔离 profile，不碰任何应用数据），
 * 注册完直接关掉即可；不留后台、不改设置、不写注册表。
 *
 * 运行：env -u ELECTRON_RUN_AS_NODE npx electron dev-tests/github-signup-popup.js
 */
'use strict';
const { app, BrowserWindow } = require('electron');

/* 独立 profile：和 PlanQuest 的用户数据目录彻底分开 */
app.setPath('userData', require('path').join(app.getPath('temp'), 'PQ-GitHub-Signup-Popup'));

function openSignup() {
  const win = new BrowserWindow({
    width: 1024,
    height: 760,
    title: '注册 GitHub（临时窗口）',
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'github-signup-temp', // 会话隔离，关闭即丢弃
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.loadURL('https://github.com/signup');

  /* 新窗口若被站点要求弹出（如邮箱验证），交给系统浏览器 */
  win.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => app.quit());
}

app.disableHardwareAcceleration();
app.whenReady().then(openSignup);
