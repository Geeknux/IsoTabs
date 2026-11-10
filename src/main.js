const { app, BrowserWindow, WebContentsView, ipcMain, session, Menu, dialog, clipboard, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createIdentity, identityFromSeed } = require('./identity');

const SEARCH_URL = 'https://www.google.com/search?q=';

// WebRTC must never bypass a tab's proxy: without this, a page's
// RTCPeerConnection still gathers the machine's real public IP via STUN even
// when all HTTP goes through the tab's proxy (the classic "WebRTC leak").
// Relay-only candidate gathering keeps each tab's IP story consistent, and
// spoof.js presents the proxy's exit IP (fetched below) as the tab's public
// candidate so WebRTC and HTTP report the same address. Trade-off: direct
// P2P connections need a TURN server, like any VPN browser.
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');

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
/** @type {{id:string,name:string,color:string,url:string,title:string,favicon:string|null,loading:boolean,view:WebContentsView|null,identity:object,proxy:string,publicIp:string|null}}[]} */
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
      // The stored seed regenerates the exact same fake identity on restart,
      // so a tab's fingerprint survives restarts. Tabs from older saves (or a
      // corrupt seed) get a fresh identity.
      identity: Number.isInteger(t.seed) ? identityFromSeed(t.seed) : createIdentity(),
      proxy: typeof t.proxy === 'string' ? t.proxy : '',
      publicIp: null, // re-fetched from the proxy when the tab loads
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
  const data = {
    activeId,
    tabs: tabs.map(({ id, name, color, url, identity, proxy }) => ({ id, name, color, url, seed: identity.seed, proxy })),
  };
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
        proxy: t.proxy,
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
    identity: createIdentity(),
    proxy: '',
    publicIp: null,
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
      // The spoof preload must patch the page's own window object, so it runs
      // with contextIsolation off; sandbox stays on and nodeIntegration off,
      // and it only ever talks to main over one synchronous IPC channel.
      preload: path.join(__dirname, 'spoof.js'),
      contextIsolation: false,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  tab.view.setBackgroundColor('#ffffff');
  configureSession(tab.view.webContents.session, tab.identity, tab.proxy);
  wireTab(tab);
  const wc = tab.view.webContents;
  restoreSessionCookies(tab.id).finally(async () => {
    // Proxied tabs learn their exit IP through the proxy before the first
    // page load, so the spoof layer can present it as the WebRTC address.
    // setProxy is awaited again here: configureSession fires it without
    // waiting, and a direct echo lookup would return the REAL IP.
    if (tab.proxy && !tab.publicIp) {
      try {
        await wc.session.setProxy({ mode: 'fixed_servers', proxyRules: tab.proxy });
        tab.publicIp = await fetchExitIp(wc.session);
      } catch {}
    }
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
  dismissPrompt();
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

// Proxy rules as Chromium accepts them: either a single "scheme://host:port"
// proxy (socks5/socks5h/http/https/quic) or a per-protocol list like
// "http=user:pass@proxy:8080;https=proxy:8443". Empty means direct.
const PROXY_URL_RE = /^(?:socks5h?|http|https|quic):\/\/[^\s]+$/i;
const PROXY_LIST_RE = /^[a-z]+=[^;]+(?:;[a-z]+=[^;]+)*$/i;
const IP_ECHO_URLS = ['https://api.ipify.org/?format=json', 'https://api64.ipify.org/?format=json'];

// The public IP the proxy exits from, asked through the tab's own proxied
// session — the same route the tab's HTTP traffic takes, so the answer is the
// address sites see. spoof.js presents it as the tab's WebRTC candidate.
// Null (no proxy, or the lookups failed) means WebRTC stays fully hidden.
async function fetchExitIp(ses) {
  for (const url of IP_ECHO_URLS) {
    try {
      const res = await Promise.race([
        ses.fetch(url),
        new Promise((_r, rej) => setTimeout(() => rej(new Error('echo timeout')), 6000)),
      ]);
      const text = (await res.text()).trim();
      let ip = text;
      try {
        ip = JSON.parse(text).ip || text;
      } catch {}
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || /^[0-9a-f:]+:[0-9a-f:]+$/i.test(ip)) return ip;
    } catch {}
  }
  return null;
}

async function setTabProxy(id, proxy) {
  const tab = getTab(id);
  if (!tab) return;
  const clean = String(proxy ?? '').trim().slice(0, 500);
  if (clean && !PROXY_URL_RE.test(clean) && !PROXY_LIST_RE.test(clean)) return;
  tab.proxy = clean;
  tab.publicIp = null;
  if (tab.view) {
    const ses = tab.view.webContents.session;
    // Apply the route first, then learn its exit IP through it, then reload
    // so the fresh page already sees a complete identity over IPC.
    try {
      await ses.setProxy(clean ? { mode: 'fixed_servers', proxyRules: clean } : { mode: 'direct' });
      if (clean) tab.publicIp = await fetchExitIp(ses);
    } catch {}
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.reload();
  }
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
function configureSession(ses, identity, proxy) {
  if (configuredSessions.has(ses)) return;
  configuredSessions.add(ses);

  // Network-level identity: UA + languages consistent with the JS-level spoof.
  ses.setUserAgent(identity.ua, identity.languages.join(','));
  if (proxy) {
    ses.setProxy({ mode: 'fixed_servers', proxyRules: proxy }).catch(() => {});
  }

  // Client Hints headers must agree with the fake UA, or the mismatch between
  // sec-ch-ua / sec-ch-ua-platform and navigator.userAgent flags the browser.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    headers['sec-ch-ua'] = identity.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = identity.chPlatform;
    callback({ requestHeaders: headers });
  });

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    // local-fonts reads the real installed fonts — never grant it.
    if (permission === 'local-fonts') return callback(false);
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
          // Popups share the tab's session AND its fake identity: the same
          // preload answers the spoof-config query via the tab lookup.
          webPreferences: {
            partition: partitionOf(tab.id),
            preload: path.join(__dirname, 'spoof.js'),
            contextIsolation: false,
            sandbox: true,
            nodeIntegration: false,
          },
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
    {
      label: tab.proxy ? `Proxy… (in use: ${tab.proxy.slice(0, 24)})` : 'Proxy…',
      click: () => {
        promptValue({
          title: `Proxy for "${tab.name}"`,
          label:
            'Routes all of this tab\'s traffic through one proxy, so its IP differs\n' +
            'from your other tabs. Chromium proxy rules, for example:\n' +
            'socks5://127.0.0.1:1080  ·  http=proxy:8080;https=proxy:8443\n' +
            'Leave empty for a direct connection. The tab reloads to apply it.',
          value: tab.proxy || '',
          placeholder: 'socks5://127.0.0.1:1080',
          onSave: (value) => setTabProxy(id, value),
        });
      },
    },
    { type: 'separator' },
    { label: 'Close tab', accelerator: 'CmdOrCtrl+W', click: () => closeTab(id) },
  ]).popup({ window: win });
}

// A one-field dialog rendered in the browser UI: main can't show inputs with
// Electron's native dialog, so it delegates to the renderer over IPC. The
// active page view natively overlays the whole UI renderer, so it is hidden
// while the prompt is up — otherwise the modal would be painted over by the
// page on any tab with content loaded.
let pendingPrompt = null;
let promptHiddenView = null;
function promptValue({ title, label, value = '', placeholder = '', onSave }) {
  if (!win || !uiReady) return;
  const tab = activeTab();
  if (tab?.view) {
    promptHiddenView = tab.view;
    win.contentView.removeChildView(tab.view);
  }
  win.webContents.focus();
  win.webContents.send('ui:prompt', { kind: 'proxy', title, label, value, placeholder });
  pendingPrompt = { kind: 'proxy', onSave };
}

function restorePromptView() {
  const view = promptHiddenView;
  promptHiddenView = null;
  if (!view || !win || view.webContents.isDestroyed()) return;
  const tab = tabs.find((t) => t.view === view);
  if (tab && tab.id === activeId) {
    win.contentView.addChildView(view);
    layout();
    view.webContents.focus();
  }
}

// Keyboard shortcuts (Ctrl+T, tab switching...) still work with the prompt
// open; switching tabs dismisses it instead of leaving it half-hidden.
function dismissPrompt() {
  if (!pendingPrompt && !promptHiddenView) return;
  pendingPrompt = null;
  if (win && uiReady) win.webContents.send('ui:close-prompt');
  restorePromptView();
}

on('ui:prompt-value', (value) => {
  const prompt = pendingPrompt;
  pendingPrompt = null;
  restorePromptView();
  // null = cancelled; "" (empty proxy = direct connection) is a real answer.
  if (prompt && value != null) prompt.onSave(String(value));
});

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
on('tabs:proxy', (id, proxy) => setTabProxy(id, proxy));
on('tabs:reorder', (ids) => reorder(ids));
on('tabs:menu', (id) => showTabMenu(id));
on('nav:go', (text) => navigate(text));
on('nav:back', () => withActive((wc) => wc.navigationHistory.goBack()));
on('nav:forward', () => withActive((wc) => wc.navigationHistory.goForward()));
on('nav:reload', () => withActive((wc) => wc.reload()));
on('nav:stop', () => withActive((wc) => wc.stop()));
on('nav:focus-page', () => withActive((wc) => wc.focus()));

// The spoof preload (contextIsolation off, so it runs inside the page world)
// asks for its tab's fake identity synchronously before any page script runs.
// The tab is identified by the session partition of the sender.
ipcMain.on('spoof-config', (event) => {
  const partition = event.sender.session?.partition || '';
  const id = partition.startsWith('persist:tab-') ? partition.slice('persist:tab-'.length) : null;
  const tab = id ? getTab(id) : null;
  // webrtcIp: the proxy's exit IP (null without a proxy) — the spoof layer
  // presents it as the tab's public WebRTC candidate.
  event.returnValue = tab ? { ...tab.identity, webrtcIp: tab.publicIp } : null;
});

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
