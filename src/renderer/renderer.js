const api = window.browser;
document.body.classList.add(api.platform);

const $ = (id) => document.getElementById(id);
const tabsEl = $('tabs');
const address = $('address');
const identity = $('identity');
const backBtn = $('back');
const forwardBtn = $('forward');
const reloadBtn = $('reload');

const CLOSE_ICON = '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

let state = { tabs: [], activeId: null };
let lastActiveId = null;
let editingId = null;
let pendingRename = null;
let dragId = null;
const elements = new Map();

const findTab = (id) => state.tabs.find((t) => t.id === id);

// Show percent-encoded URLs readably (e.g. Persian paths), as Chrome does. "%25" and characters
// that are invisible or reorder text (spaces, controls, bidi marks) stay encoded so the shown
// URL can't hide or spoof anything; ZWNJ/ZWJ are allowed since Persian words use them.
const UNSAFE_IN_URL = /[\s\p{Cc}\p{Cf}]/gu;
function displayUrl(url) {
  if (!url) return '';
  try {
    return decodeURI(url.replace(/%25/gi, '%2525')).replace(UNSAFE_IN_URL, (c) =>
      c === '‌' || c === '‍' ? c : encodeURIComponent(c),
    );
  } catch {
    return url;
  }
}

// ---------- tab elements ----------

function createTabEl(id) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.draggable = true;
  el.dataset.id = id;
  el.innerHTML = `<span class="icon"></span><span class="name" dir="auto"></span><button class="close" title="Close tab (Ctrl+W)">${CLOSE_ICON}</button>`;

  el.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('.close, .name-input')) api.activate(id);
  });
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) api.close(id);
  });
  el.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.close')) startRename(id);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.tabMenu(id);
  });
  el.querySelector('.close').addEventListener('click', (e) => {
    e.stopPropagation();
    api.close(id);
  });

  el.addEventListener('dragstart', (e) => {
    dragId = id;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    dragId = null;
    api.reorder([...tabsEl.children].map((c) => c.dataset.id));
  });
  el.addEventListener('dragover', (e) => {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    tabsEl.insertBefore(elements.get(dragId), after ? el.nextSibling : el);
  });
  return el;
}

function updateTabEl(el, tab) {
  el.classList.toggle('active', tab.id === state.activeId);
  el.style.setProperty('--tab-color', tab.color);
  el.title = [tab.name, tab.title, displayUrl(tab.url)].filter(Boolean).join('\n');
  el.querySelector('.name').textContent = tab.name;

  const icon = el.querySelector('.icon');
  const key = tab.loading ? 'loading' : tab.favicon || 'dot';
  if (icon.dataset.key === key) return;
  icon.dataset.key = key;
  if (tab.loading) {
    icon.innerHTML = '<span class="spinner"></span>';
  } else if (tab.favicon) {
    const img = new Image();
    img.onerror = () => (icon.innerHTML = '<span class="dot"></span>');
    img.src = tab.favicon;
    icon.replaceChildren(img);
  } else {
    icon.innerHTML = '<span class="dot"></span>';
  }
}

// ---------- render ----------

function render() {
  const ids = new Set(state.tabs.map((t) => t.id));
  for (const [id, el] of elements) {
    if (ids.has(id)) continue;
    el.remove();
    elements.delete(id);
  }

  state.tabs.forEach((tab, i) => {
    let el = elements.get(tab.id);
    if (!el) {
      el = createTabEl(tab.id);
      elements.set(tab.id, el);
    }
    if (!el.isConnected) tabsEl.append(el);
    if (!dragId && tabsEl.children[i] !== el) tabsEl.insertBefore(el, tabsEl.children[i] || null);
    updateTabEl(el, tab);
  });

  $('no-sandbox').hidden = state.sandboxed !== false;

  const active = findTab(state.activeId);
  if (active) {
    document.documentElement.style.setProperty('--tab-color', active.color);
    identity.textContent = active.name;
    $('blank').hidden = !!active.url;
    $('blank-name').textContent = active.name;
    backBtn.disabled = !active.canGoBack;
    forwardBtn.disabled = !active.canGoForward;
    reloadBtn.classList.toggle('loading', active.loading);
    reloadBtn.title = active.loading ? 'Stop (Esc)' : 'Reload (Ctrl+R)';
    if (document.activeElement !== address || state.activeId !== lastActiveId) address.value = displayUrl(active.url);
    elements.get(active.id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  lastActiveId = state.activeId;

  if (pendingRename && elements.has(pendingRename)) {
    const id = pendingRename;
    pendingRename = null;
    startRename(id);
  }
}

// ---------- inline rename ----------

function startRename(id) {
  const el = elements.get(id);
  if (!el) {
    pendingRename = id;
    return;
  }
  if (editingId === id) return;
  document.querySelector('.name-input')?.blur();

  editingId = id;
  el.draggable = false;
  const nameEl = el.querySelector('.name');
  const input = document.createElement('input');
  input.className = 'name-input';
  input.dir = 'auto';
  input.maxLength = 60;
  input.spellcheck = false;
  input.value = findTab(id)?.name ?? nameEl.textContent;
  nameEl.hidden = true;
  nameEl.after(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit && input.value.trim()) api.rename(id, input.value);
    input.remove();
    nameEl.hidden = false;
    el.draggable = true;
    editingId = null;
  };
  // After naming a fresh tab, jump straight to the address bar.
  const leave = () => {
    const tab = findTab(id);
    if (tab && tab.id === state.activeId && !tab.url) focusAddress();
    else api.focusPage();
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
      leave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
      leave();
    }
  });
  input.addEventListener('blur', () => finish(true));
}

// ---------- toolbar ----------

function focusAddress() {
  address.focus();
  address.select();
}

let selectOnMouseUp = false;
address.addEventListener('mousedown', () => {
  selectOnMouseUp = document.activeElement !== address;
});
address.addEventListener('mouseup', (e) => {
  if (!selectOnMouseUp) return;
  selectOnMouseUp = false;
  if (address.selectionStart === address.selectionEnd) {
    e.preventDefault();
    address.select();
  }
});
address.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  address.value = displayUrl(findTab(state.activeId)?.url);
  api.focusPage();
});
// Copying the whole, unedited address copies the real (encoded) URL, so pasted links keep working.
address.addEventListener('copy', (e) => {
  const url = findTab(state.activeId)?.url;
  if (!url || address.value !== displayUrl(url)) return;
  if (address.selectionStart !== 0 || address.selectionEnd !== address.value.length) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', url);
});

$('omnibox').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!address.value.trim()) return;
  const url = findTab(state.activeId)?.url;
  api.navigate(url && address.value === displayUrl(url) ? url : address.value);
  address.blur();
});

$('new-tab').addEventListener('click', () => api.newTab());
backBtn.addEventListener('click', () => api.back());
forwardBtn.addEventListener('click', () => api.forward());
reloadBtn.addEventListener('click', () => (findTab(state.activeId)?.loading ? api.stop() : api.reload()));
identity.addEventListener('dblclick', () => state.activeId && startRename(state.activeId));
identity.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (state.activeId) api.tabMenu(state.activeId);
});
tabsEl.addEventListener('dblclick', (e) => {
  if (e.target === tabsEl) api.newTab();
});

// Keep the page view positioned right under the browser chrome.
new ResizeObserver(([entry]) => api.setChromeHeight(entry.target.getBoundingClientRect().height)).observe($('chrome'));

api.onState((next) => {
  state = next;
  render();
});
api.onRename((id) => startRename(id));
api.onFocusAddress(focusAddress);
