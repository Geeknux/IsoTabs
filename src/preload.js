const { contextBridge, ipcRenderer } = require('electron');

const send = (channel) => (...args) => ipcRenderer.send(channel, ...args);
const listen = (channel) => (cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args));

contextBridge.exposeInMainWorld('browser', {
  platform: process.platform,
  newTab: send('tabs:new'),
  activate: send('tabs:activate'),
  close: send('tabs:close'),
  rename: send('tabs:rename'),
  reorder: send('tabs:reorder'),
  tabMenu: send('tabs:menu'),
  setProxy: send('tabs:proxy'),
  navigate: send('nav:go'),
  back: send('nav:back'),
  forward: send('nav:forward'),
  reload: send('nav:reload'),
  stop: send('nav:stop'),
  focusPage: send('nav:focus-page'),
  setChromeHeight: send('ui:chrome-height'),
  onState: listen('state'),
  onRename: listen('ui:rename'),
  onFocusAddress: listen('ui:focus-address'),
  onPrompt: listen('ui:prompt'),
  onClosePrompt: listen('ui:close-prompt'),
  // null means the user cancelled the prompt; "" is a real (empty) answer.
  sendPromptValue: send('ui:prompt-value'),
});
