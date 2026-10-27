const { app, BrowserWindow, WebContentsView, ipcMain, session, Menu, dialog, clipboard, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const SEARCH_URL = 'https://www.google.com/search?q=';

const COLORS = [
  ['Blue', '#8ab4f8'],
  ['Green', '#81c995'],
  ['Yellow', '#fdd663'],
  ['Red', '#f28b82'],
  ['Purple', '#c58af9'],
  ['Cyan', '#78d9ec'],
  ['Orange', '#fcad70'],
  ['Pink', '#ff8bcb'],
  ['Grey', '#9aa0a6'],
];

// Permissions granted silently / asked about / everything else is denied.
const SAFE_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);
const ASK_PERMISSIONS = new Set(['media', 'geolocation', 'notifications', 'clipboard-read']);

let win = null;
let uiReady = false;
let renameOnLoad = null;
let chromeHeight = 80;
let activeId = null;
/** @type {{id:string,name:string,color:string,url:string,title:string,favicon:string|null,loading:boolean,view:WebContentsView|null}[]} */
let tabs = [];

// Every tab lives in its own persistent partition: separate cookies, localStorage,
// IndexedDB, cache and service workers, stored on disk under userData/Partitions/tab-<id>.
// A tab with no URL yet has no view at all; the UI draws its blank page.
const partitionOf = (id) => `persist:tab-${id}`;
const storeFile = () => path.join(app.getPath('userData'), 'tabs.json');
const sessionCookieDir = () => path.join(app.getPath('userData'), 'SessionCookies');
const sessionCookieFile = (id) => path.join(sessionCookieDir(), `tab-${id}.bin`);
const getTab = (id) => tabs.find((t) => t.id === id);
const activeTab = () => getTab(activeId);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(start);
}

function start() {
  // Look like plain Chrome: drop the "Electron/x" and "IsoTabs/x" tokens some sites block on.
  app.userAgentFallback = app.userAgentFallback.replace(/ (?!(?:AppleWebKit|Chrome|Safari)\/)[^\s()]+\/\S+/g, '');

  loadStore();
  removeOrphanPartitions();
  createWindow();

  if (!tabs.length) newTab({ rename: true });
  else activate(getTab(activeId) ? activeId : tabs[0].id);
}

// ---------- persistence ----------

function loadStore() {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    tabs = (data.tabs || []).map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color || COLORS[0][1],
      url: t.url || '',
      title: '',
      favicon: null,
      loading: false,
      view: null,
    }));
    activeId = data.activeId;
  } catch {
    tabs = [];
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

function saveNow() {
  clearTimeout(saveTimer);
  const data = { activeId, tabs: tabs.map(({ id, name, color, url }) => ({ id, name, color, url })) };
  const file = storeFile();
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(file + '.tmp', file);
}

// Data of closed tabs is cleared immediately, but the folder can only be removed
// once no session holds it open, i.e. on the next start before any tab loads.
function removeOrphanPartitions() {
  const keep = new Set(tabs.map((t) => `tab-${t.id}`));
  for (const dir of [path.join(app.getPath('userData'), 'Partitions'), sessionCookieDir()]) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith('tab-') || keep.has(path.parse(name).name)) continue;
      try {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      } catch {}
    }
  }
}

// Chromium drops cookies without an expiry date on restart, and many logins use them.
// Like Chrome's "continue where you left off", keep them (encrypted with the OS
// keystore) and put them back before the tab loads again.
async function saveSessionCookies(id) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return;
  const cookies = (await session.fromPartition(partitionOf(id)).cookies.get({})).filter((c) => c.session);
  const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(cookies));
  fs.mkdirSync(sessionCookieDir(), { recursive: true });
  fs.writeFileSync(sessionCookieFile(id), encrypted);
}

async function restoreSessionCookies(id) {
  let cookies;
  try {
    const { result } = await safeStorage.decryptStringAsync(fs.readFileSync(sessionCookieFile(id)));
    cookies = JSON.parse(result);
  } catch {
    return;
  }
  const ses = session.fromPartition(partitionOf(id));
  await Promise.allSettled(
    cookies.map((c) =>
      ses.cookies.set({
        url: `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path}`,
        name: c.name,
        value: c.value,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        ...(c.hostOnly ? {} : { domain: c.domain }),
      }),
    ),
  );
}

// ---------- window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 480,
    minHeight: 300,
    backgroundColor: '#1f2023',
    title: 'IsoTabs',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1f2023', symbolColor: '#e8eaed', height: 38 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('before-input-event', handleShortcut);
  win.webContents.on('did-finish-load', () => {
    uiReady = true;
    win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
    pushState();
    if (renameOnLoad) requestRename(renameOnLoad);
    else if (activeTab() && !activeTab().url) focusAddress();
    renameOnLoad = null;
  });
  win.on('resize', layout);
  win.on('closed', () => (win = null));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function layout() {
  const tab = activeTab();
  if (!win || !tab?.view) return;
  const [width, height] = win.getContentSize();
  tab.view.setBounds({ x: 0, y: chromeHeight, width, height: Math.max(0, height - chromeHeight) });
}

function pushState() {
  if (!win || !uiReady) return;
  const tab = activeTab();
  win.setTitle(tab ? `${tab.name} – IsoTabs` : 'IsoTabs');
  win.webContents.send('state', {
    activeId,
    colors: COLORS,
    // The Linux AppImage launcher adds --no-sandbox when the system blocks user namespaces.
    sandboxed: !app.commandLine.hasSwitch('no-sandbox'),
    tabs: tabs.map((t) => {
      const history = t.view?.webContents.navigationHistory;
      return {
        id: t.id,
        name: t.name,
        color: t.color,
        url: t.url,
        title: t.title,
        favicon: t.favicon,
        loading: t.loading,
        canGoBack: history ? history.canGoBack() : false,
        canGoForward: history ? history.canGoForward() : false,
      };
    }),
  });
}

// ---------- tabs ----------

function uniqueName() {
  const used = new Set(tabs.map((t) => t.name));
  let n = tabs.length + 1;
  while (used.has(`Tab ${n}`)) n++;
  return `Tab ${n}`;
}

function newTab({ rename = true } = {}) {
  const tab = {
    id: crypto.randomUUID(),
    name: uniqueName(),
    color: COLORS[tabs.length % COLORS.length][1],
    url: '',
    title: '',
    favicon: null,
    loading: false,
    view: null,
  };
  tabs.push(tab);
  activate(tab.id);
  if (rename) requestRename(tab.id);
  return tab;
}

function requestRename(id) {
  if (!win || !getTab(id)) return;
  if (!uiReady) return void (renameOnLoad = id);
  win.webContents.focus();
  win.webContents.send('ui:rename', id);
}

function ensureView(tab, url = tab.url) {
  if (tab.view) return tab.view;
  tab.view = new WebContentsView({
    webPreferences: {
      partition: partitionOf(tab.id),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  tab.view.setBackgroundColor('#ffffff');
  configureSession(tab.view.webContents.session);
  wireTab(tab);
  const wc = tab.view.webContents;
  restoreSessionCookies(tab.id).finally(() => {
    if (!wc.isDestroyed()) wc.loadURL(url);
  });
  return tab.view;
}

function showView(tab) {
  win.contentView.addChildView(tab.view);
  layout();
}

function activate(id) {
  const tab = getTab(id);
  if (!tab || !win) return;
  const prev = activeTab();
  activeId = id;
  // Move focus before swapping views: removing the focused view makes Chromium
  // hand focus to the next view, which would steal it back from the browser UI.
  if (!tab.url && uiReady) win.webContents.focus();
  if (prev && prev !== tab && prev.view) win.contentView.removeChildView(prev.view);

  if (tab.url) {
    ensureView(tab);
    showView(tab);
    const wc = tab.view.webContents;
    if (wc.isCrashed()) wc.reload();
    wc.focus();
  } else {
    focusAddress();
  }
  pushState();
  save();
}

async function closeTab(id) {
  const tab = getTab(id);
  if (!tab) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Close and delete its data', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message: `Close "${tab.name}"?`,
    detail: 'All cookies, logins, site storage and cache of this tab will be permanently deleted.',
  });
  if (response !== 0 || !getTab(id)) return;

  const index = tabs.indexOf(tab);
  tabs.splice(index, 1);
  if (tab.view) {
    win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    tab.view = null;
  }
  await wipeSession(id);

  if (activeId === id) {
    activeId = null;
    const next = tabs[index] || tabs[index - 1];
    if (next) activate(next.id);
    else newTab();
  }
  pushState();
  save();
}

async function wipeSession(id) {
  const ses = session.fromPartition(partitionOf(id));
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.clearAuthCache();
  fs.rmSync(sessionCookieFile(id), { force: true });
}

async function clearTabData(id) {
  const tab = getTab(id);
  if (!tab) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Clear data', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message: `Clear all data of "${tab.name}"?`,
    detail: 'Cookies, logins, site storage and cache of this tab will be deleted. The tab stays open.',
  });
  if (response !== 0) return;
  await wipeSession(id);
  tab.view?.webContents.reload();
}

function renameTab(id, name) {
  const tab = getTab(id);
  const clean = String(name ?? '').trim().slice(0, 60);
  if (!tab || !clean) return;
  tab.name = clean;
  pushState();
  save();
}

function setColor(id, color) {
  const tab = getTab(id);
  if (!tab) return;
  tab.color = color;
  pushState();
  save();
}

function reorder(ids) {
  if (!Array.isArray(ids) || ids.length !== tabs.length) return;
  const next = ids.map(getTab);
  if (next.some((t) => !t) || new Set(next).size !== tabs.length) return;
  tabs = next;
  pushState();
  save();
}

function cycle(step) {
  if (!tabs.length) return;
  const i = tabs.indexOf(activeTab());
  activate(tabs[(i + step + tabs.length) % tabs.length].id);
}

function focusAddress() {
  if (!win || !uiReady) return;
  win.webContents.focus();
  win.webContents.send('ui:focus-address');
}

// ---------- per-tab web contents ----------

const configuredSessions = new WeakSet();
function configureSession(ses) {
  if (configuredSessions.has(ses)) return;
  configuredSessions.add(ses);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (SAFE_PERMISSIONS.has(permission)) return callback(true);
    if (!ASK_PERMISSIONS.has(permission) || !win) return callback(false);
    const tab = tabs.find((t) => t.view?.webContents === wc);
    let origin = details.requestingUrl;
    try {
      origin = new URL(details.requestingUrl).origin;
    } catch {}
    dialog
      .showMessageBox(win, {
        type: 'question',
        buttons: ['Allow', 'Block'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        message: `${origin} wants to use: ${permission}`,
        detail: tab ? `Tab: ${tab.name}` : undefined,
      })
      .then(({ response }) => callback(response === 0));
  });
}

function wireTab(tab) {
  const wc = tab.view.webContents;
  const isActive = () => activeId === tab.id;

  wc.on('page-title-updated', (_e, title) => {
    tab.title = title;
    pushState();
  });
  wc.on('page-favicon-updated', async (_e, favicons) => {
    const url = favicons[0];
    tab.faviconUrl = url;
    const data = url ? await fetchFavicon(wc.session, url) : null;
    if (tab.faviconUrl !== url) return;
    tab.favicon = data;
    pushState();
  });
  wc.on('did-start-loading', () => {
    tab.loading = true;
    pushState();
  });
  wc.on('did-stop-loading', () => {
    tab.loading = false;
    pushState();
  });
  wc.on('did-navigate', (_e, url) => {
    tab.url = url;
    tab.favicon = tab.faviconUrl = null;
    pushState();
    save();
  });
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (!isMainFrame) return;
    tab.url = url;
    pushState();
    save();
  });
  wc.on('before-input-event', handleShortcut);
  wc.on('context-menu', (_e, params) => showPageMenu(tab, params));
  wc.on('render-process-gone', () => {
    tab.loading = false;
    pushState();
  });

  // Real popups (OAuth, payment windows...) open as windows that share this tab's
  // session; target=_blank / ctrl+click links stay in the tab, since a new tab
  // here would mean a new, empty identity.
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (disposition === 'new-window' || !url || url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 960,
          height: 720,
          autoHideMenuBar: true,
          backgroundColor: '#ffffff',
          webPreferences: { partition: partitionOf(tab.id), sandbox: true, contextIsolation: true },
        },
      };
    }
    wc.loadURL(url);
    return { action: 'deny' };
  });
  wc.on('did-create-window', (child) => {
    child.setTitle(`${tab.name} – popup`);
    child.webContents.on('page-title-updated', (e, title) => {
      e.preventDefault();
      child.setTitle(`${tab.name} – ${title}`);
    });
  });

  if (isActive()) layout();
}

// Favicons are fetched through the tab's own session and handed to the UI as data
// URLs, so the browser UI never makes requests that could link identities.
async function fetchFavicon(ses, url) {
  if (url.startsWith('data:image/')) return url;
  try {
    const res = await ses.fetch(url);
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 256 * 1024) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function showPageMenu(tab, params) {
  const wc = tab.view.webContents;
  const history = wc.navigationHistory;
  const items = [];
  const sep = { type: 'separator' };

  if (params.linkURL) {
    items.push(
      { label: 'Open link', click: () => wc.loadURL(params.linkURL) },
      { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
      sep,
    );
  }
  if (params.mediaType === 'image' && params.srcURL) {
    items.push(
      { label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) },
      { label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) },
      sep,
    );
  }
  if (params.isEditable) {
    items.push(
      { label: 'Undo', enabled: params.editFlags.canUndo, click: () => wc.undo() },
      { label: 'Redo', enabled: params.editFlags.canRedo, click: () => wc.redo() },
      sep,
      { label: 'Cut', enabled: params.editFlags.canCut, click: () => wc.cut() },
      { label: 'Copy', enabled: params.editFlags.canCopy, click: () => wc.copy() },
      { label: 'Paste', enabled: params.editFlags.canPaste, click: () => wc.paste() },
      { label: 'Select all', click: () => wc.selectAll() },
      sep,
    );
  } else if (params.selectionText) {
    items.push(
      { label: 'Copy', click: () => wc.copy() },
      {
        label: `Search Google for "${params.selectionText.trim().slice(0, 30)}"`,
        click: () => wc.loadURL(SEARCH_URL + encodeURIComponent(params.selectionText.trim())),
      },
      sep,
    );
  }
  items.push(
    { label: 'Back', enabled: history.canGoBack(), click: () => history.goBack() },
    { label: 'Forward', enabled: history.canGoForward(), click: () => history.goForward() },
    { label: 'Reload', click: () => wc.reload() },
    sep,
    { label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) },
  );
  Menu.buildFromTemplate(items).popup({ window: win });
}

function showTabMenu(id) {
  const tab = getTab(id);
  if (!tab) return;
  Menu.buildFromTemplate([
    { label: 'Rename…', accelerator: 'F2', click: () => requestRename(id) },
    {
      label: 'Color',
      submenu: COLORS.map(([label, color]) => ({
        label,
        type: 'radio',
        checked: tab.color === color,
        click: () => setColor(id, color),
      })),
    },
    { type: 'separator' },
    { label: 'Reload', click: () => tab.view?.webContents.reload() },
    { label: 'Clear cookies and site data…', click: () => clearTabData(id) },
    { type: 'separator' },
    { label: 'Close tab', accelerator: 'CmdOrCtrl+W', click: () => closeTab(id) },
  ]).popup({ window: win });
}

// ---------- navigation ----------

function toUrl(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (/^(https?|file|about|data|view-source):/i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(s)) return 'http://' + s;
  if (!/\s/.test(s) && /^[^/?#]+\.[a-z¡-￿]{2,}(:\d+)?([/?#].*)?$/i.test(s)) return 'https://' + s;
  return SEARCH_URL + encodeURIComponent(s);
}

function navigate(text) {
  const url = toUrl(text);
  const tab = activeTab();
  if (!url || !tab) return;
  if (tab.view) {
    tab.view.webContents.loadURL(url);
  } else {
    tab.url = url;
    ensureView(tab, url);
    showView(tab);
  }
  tab.view.webContents.focus();
  pushState();
  save();
}

function withActive(fn) {
  const wc = activeTab()?.view?.webContents;
  if (wc && !wc.isDestroyed()) fn(wc);
}

// Matched on physical key codes so shortcuts keep working with a Persian keyboard layout.
function handleShortcut(event, input) {
  if (input.type !== 'keyDown') return;
  const ctrl = input.control || input.meta;
  const { code, shift, alt } = input;
  let handled = true;

  if (ctrl && code === 'KeyT') newTab();
  else if (ctrl && code === 'KeyW') closeTab(activeId);
  else if ((ctrl && code === 'KeyL') || (alt && code === 'KeyD')) focusAddress();
  else if (ctrl && code === 'Tab') cycle(shift ? -1 : 1);
  else if (ctrl && code === 'PageDown') cycle(1);
  else if (ctrl && code === 'PageUp') cycle(-1);
  else if (ctrl && /^Digit[1-9]$/.test(code)) {
    const n = Number(code.slice(5));
    const tab = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
    if (tab) activate(tab.id);
  } else if ((ctrl && code === 'KeyR') || code === 'F5')
    withActive((wc) => (shift || ctrl && code === 'F5' ? wc.reloadIgnoringCache() : wc.reload()));
  else if (alt && code === 'ArrowLeft') withActive((wc) => wc.navigationHistory.goBack());
  else if (alt && code === 'ArrowRight') withActive((wc) => wc.navigationHistory.goForward());
  else if (code === 'F12' || (ctrl && shift && code === 'KeyI')) withActive((wc) => wc.toggleDevTools());
  else if (code === 'F2') requestRename(activeId);
  else if (ctrl && (code === 'Equal' || code === 'NumpadAdd')) withActive((wc) => wc.setZoomLevel(wc.getZoomLevel() + 0.5));
  else if (ctrl && (code === 'Minus' || code === 'NumpadSubtract')) withActive((wc) => wc.setZoomLevel(wc.getZoomLevel() - 0.5));
  else if (ctrl && (code === 'Digit0' || code === 'Numpad0')) withActive((wc) => wc.setZoomLevel(0));
  else if (code === 'Escape' && event.sender === activeTab()?.view?.webContents && event.sender.isLoading()) event.sender.stop();
  else handled = false;

  if (handled) event.preventDefault();
}

// ---------- IPC from the browser UI ----------

function on(channel, fn) {
  ipcMain.on(channel, (event, ...args) => {
    if (win && event.sender === win.webContents) fn(...args);
  });
}

on('ui:chrome-height', (h) => {
  const height = Math.round(Number(h));
  if (!Number.isFinite(height) || height < 0 || height === chromeHeight) return;
  chromeHeight = height;
  layout();
});
on('tabs:new', () => newTab());
on('tabs:activate', (id) => activate(id));
on('tabs:close', (id) => closeTab(id));
on('tabs:rename', (id, name) => renameTab(id, name));
on('tabs:reorder', (ids) => reorder(ids));
on('tabs:menu', (id) => showTabMenu(id));
on('nav:go', (text) => navigate(text));
on('nav:back', () => withActive((wc) => wc.navigationHistory.goBack()));
on('nav:forward', () => withActive((wc) => wc.navigationHistory.goForward()));
on('nav:reload', () => withActive((wc) => wc.reload()));
on('nav:stop', () => withActive((wc) => wc.stop()));
on('nav:focus-page', () => withActive((wc) => wc.focus()));

// ---------- shutdown ----------

let flushed = false;
app.on('before-quit', async (event) => {
  if (flushed) return;
  event.preventDefault();
  flushed = true;
  saveNow();
  // Tabs never opened this run keep their saved session cookies untouched.
  const loaded = tabs.filter((t) => t.view);
  await Promise.allSettled(loaded.map((t) => saveSessionCookies(t.id)));
  await Promise.allSettled(loaded.map((t) => session.fromPartition(partitionOf(t.id)).cookies.flushStore()));
  app.quit();
});

app.on('window-all-closed', () => app.quit());
