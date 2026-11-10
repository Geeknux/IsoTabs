// Runs in every tab BEFORE page scripts (injected as a preload with
// contextIsolation disabled so it can patch the real `window` the page sees).
// The identity arrives over synchronous IPC so it is available before the
// first line of page code executes. This file never runs in the browser UI.
const { ipcRenderer } = require('electron');

const identity = ipcRenderer.sendSync('spoof-config');
if (!identity) throw new Error('spoof: no identity for this tab');

// ---------------------------------------------------------------------------
// Native disguise. Every function this file replaces would otherwise show its
// JS source through fn.toString() — an obvious tell that the environment is
// patched. Function.prototype.toString becomes a WeakMap lookup so replaced
// functions report Chrome's "[native code]" source; everything else passes
// through to the real toString untouched.
// ---------------------------------------------------------------------------
const nativeSource = new WeakMap();
const origFnToString = Function.prototype.toString;
const patchedToString = function toString() {
  const fake = nativeSource.get(this);
  return fake !== undefined ? fake : origFnToString.call(this);
};
try {
  Object.defineProperty(Function.prototype, 'toString', {
    value: patchedToString,
    writable: true,
    configurable: true,
  });
  nativeSource.set(patchedToString, origFnToString.call(origFnToString));
} catch {}

// fn reports as `function <name>() { [native code] }`; kind is 'get'/'set'
// for accessor descriptors. fn.name is fixed too, since pages read it.
function disguise(fn, name, kind = '') {
  const label = kind ? `${kind} ${name}` : name;
  try { nativeSource.set(fn, `function ${label}() { [native code] }`); } catch {}
  try { Object.defineProperty(fn, 'name', { value: label, configurable: true }); } catch {}
  return fn;
}

// ---------------------------------------------------------------------------
// Small helpers. All fingerprint noise derives from the tab's seed, so the
// same tab always reports the same (fake) values — stable across reloads.
// ---------------------------------------------------------------------------
function hashNoise(x, y, c, key) {
  let h = Math.imul(x + 0x9E3779B9, 0x85EBCA6B) ^ Math.imul(y + 0x165667B1, 0xC2B2AE35) ^ Math.imul(c + 1, 0x27D4EB2F) ^ key;
  h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D);
  h = Math.imul(h ^ (h >>> 12), 0x297A2D39);
  h ^= h >>> 15;
  return ((h >>> 0) / 4294967296) * 2 - 1; // [-1, 1]
}

// Chrome keeps spoofable attributes as getters on prototypes (Navigator.prototype,
// Screen.prototype, ...), so we patch them there. An own property on the
// navigator/screen instance would itself be a detectable shape difference;
// the instance is only used as a fallback if the prototype refuses.
const defineGetter = (obj, prop, fn) => {
  const getter = disguise(fn, prop, 'get');
  try {
    Object.defineProperty(obj, prop, { get: getter, configurable: true });
    return true;
  } catch {
    return false;
  }
};
const define = (obj, prop, value) => defineGetter(obj, prop, () => value);
const defineProto = (proto, instance, prop, value) => {
  if (!define(proto, prop, value)) define(instance, prop, value);
};

// ---------------------------------------------------------------------------
// navigator
// ---------------------------------------------------------------------------
const nav = navigator;
const navProto = Object.getPrototypeOf(navigator); // Navigator.prototype

// The real UA leaks "Electron/45" — replace it so navigator.userAgent itself
// carries only the fake Chrome identity.
defineProto(navProto, nav, 'userAgent', identity.ua);
defineProto(navProto, nav, 'language', identity.languages[0]);
defineProto(navProto, nav, 'platform', identity.platform);
defineProto(navProto, nav, 'hardwareConcurrency', identity.hardwareConcurrency);
defineProto(navProto, nav, 'deviceMemory', identity.deviceMemory);
defineProto(navProto, nav, 'webdriver', false);
// languages/brands are FrozenArray attributes: a fresh frozen array per access.
if (!defineGetter(navProto, 'languages', () => Object.freeze([...identity.languages]))) {
  define(nav, 'languages', Object.freeze([...identity.languages]));
}

if (nav.userAgentData) {
  const uad = nav.userAgentData;
  const brands = identity.brands;
  const uadProto = Object.getPrototypeOf(uad);
  try {
    defineProto(uadProto, uad, 'mobile', false);
    defineProto(uadProto, uad, 'platform', identity.uadPlatform);
    if (!defineGetter(uadProto, 'brands', () => Object.freeze([...brands]))) {
      define(uad, 'brands', Object.freeze([...brands]));
    }
    const fullVersionList = [
      { brand: 'Chromium', version: identity.chrome },
      { brand: 'Google Chrome', version: identity.chrome },
      { brand: 'Not?A_Brand', version: '248.3622.71' },
    ];
    const getHighEntropyValues = disguise(async (hints) => {
      const out = {
        architecture: identity.architecture,
        bitness: identity.bitness,
        brands: [...brands],
        fullVersionList,
        mobile: false,
        model: '',
        platform: identity.uadPlatform,
        platformVersion: identity.platformVersion,
        uaFullVersion: identity.chrome,
        wow64: false,
      };
      const want = new Set(hints);
      return Object.fromEntries(Object.entries(out).filter(([k]) => want.has(k)));
    }, 'getHighEntropyValues');
    try { uadProto.getHighEntropyValues = getHighEntropyValues; } catch {}
    if (uad.getHighEntropyValues !== getHighEntropyValues) uad.getHighEntropyValues = getHighEntropyValues;
  } catch {}
}

// navigator.plugins / mimeTypes — exactly what a real Chrome reports.
const pluginData = [
  ['PDF Viewer', 'internal-pdf-viewer'],
  ['Chrome PDF Viewer', 'internal-pdf-viewer'],
  ['Chromium PDF Viewer', 'internal-pdf-viewer'],
  ['Microsoft Edge PDF Viewer', 'internal-pdf-viewer'],
  ['WebKit built-in PDF', 'internal-pdf-viewer'],
];
const mimes = [];
const mimeObjs = {};
const pluginObjs = pluginData.map(([name, filename]) => {
  const plugin = { name, description: 'Portable Document Format viewer', filename, length: 2 };
  ['application/pdf', 'text/pdf'].forEach((type) => {
    if (!mimeObjs[type]) {
      mimeObjs[type] = { type, suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: null };
      mimes.push(mimeObjs[type]);
    }
  });
  // The same two mimes per plugin, exactly like Chrome's built-in PDF entries.
  plugin[0] = mimeObjs['application/pdf'];
  plugin[1] = mimeObjs['text/pdf'];
  plugin[0].enabledPlugin = plugin;
  plugin[1].enabledPlugin = plugin;
  return plugin;
});
try {
  Object.setPrototypeOf(pluginObjs, Object.getPrototypeOf(navigator.plugins));
  Object.setPrototypeOf(mimes, Object.getPrototypeOf(navigator.mimeTypes));
} catch {}
pluginObjs.namedItem = disguise((name) => {
  for (const p of pluginObjs) if (p.name === name) return p;
  return null;
}, 'namedItem');
mimes.namedItem = disguise((type) => mimeObjs[type] || null, 'namedItem');
defineProto(navProto, nav, 'plugins', pluginObjs);
defineProto(navProto, nav, 'mimeTypes', mimes);

// navigator.battery — a sane, stable mid-charge laptop battery.
if (nav.getBattery) {
  const battery = {
    charging: true, chargingTime: 0, dischargingTime: Infinity, level: 0.87,
    onchargingchange: null, onchargingtimechange: null, ondischargingtimechange: null, onlevelchange: null,
  };
  // Answer instanceof BatteryManager checks; the inherited EventTarget
  // methods come along natively.
  try {
    if (typeof BatteryManager !== 'undefined') Object.setPrototypeOf(battery, BatteryManager.prototype);
  } catch {}
  const getBattery = disguise(() => Promise.resolve(battery), 'getBattery');
  try { navProto.getBattery = getBattery; } catch {}
  if (nav.getBattery !== getBattery) nav.getBattery = getBattery;
}

// keyboard layout map — standard US layout.
if (nav.keyboard && nav.keyboard.getLayoutMap) {
  const kbProto = Object.getPrototypeOf(nav.keyboard);
  const getLayoutMap = disguise(async () => {
    const map = new Map();
    'abcdefghijklmnopqrstuvwxyz'.split('').forEach((c) => map.set('Key' + c.toUpperCase(), c));
    map.set('Space', ' ');
    map.set('Period', '.'); map.set('Comma', ','); map.set('Minus', '-'); map.set('Equal', '=');
    return map;
  }, 'getLayoutMap');
  try { kbProto.getLayoutMap = getLayoutMap; } catch {}
  if (nav.keyboard.getLayoutMap !== getLayoutMap) nav.keyboard.getLayoutMap = getLayoutMap;
}

// ---------------------------------------------------------------------------
// mediaDevices.enumerateDevices — real hardware counts are a fingerprint.
// Before any permission is granted, Chrome exposes only the device kinds with
// empty labels and ids, so present a stable per-tab inventory in exactly that
// shape instead of the host's real microphones/cameras.
// ---------------------------------------------------------------------------
if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
  const md = navigator.mediaDevices;
  const mdProto = Object.getPrototypeOf(md);
  const devices = [];
  const counts = {
    audioinput: 1 + (identity.noise.audio & 1),
    audiooutput: 1 + ((identity.noise.audio >> 1) & 1),
    videoinput: 1,
  };
  for (const [kind, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) devices.push({ deviceId: '', kind, label: '', groupId: '' });
  }
  const enumerateDevices = disguise(async () => devices.map((d) => ({ ...d })), 'enumerateDevices');
  try { mdProto.enumerateDevices = enumerateDevices; } catch {}
  if (md.enumerateDevices !== enumerateDevices) md.enumerateDevices = enumerateDevices;
}

// ---------------------------------------------------------------------------
// window.chrome — Electron omits it; its absence flags "not really Chrome".
// ---------------------------------------------------------------------------
window.chrome = window.chrome || {};
if (!window.chrome.app) {
  window.chrome.app = {
    isInstalled: false,
    InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    getDetails() { return null; }, getIsInstalled() { return false; },
  };
}
window.chrome.runtime = window.chrome.runtime || {};

// ---------------------------------------------------------------------------
// permissions.query fallback
// ---------------------------------------------------------------------------
if (navigator.permissions && navigator.permissions.query) {
  const perms = navigator.permissions;
  const permProto = Object.getPrototypeOf(perms);
  const origQuery = perms.query.bind(perms);
  const query = disguise((desc) =>
    origQuery(desc).catch(() => ({
      state: 'denied', onchange: null,
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
    })), 'query');
  try { permProto.query = query; } catch {}
  if (perms.query !== query) perms.query = query;
}

// ---------------------------------------------------------------------------
// screen / devicePixelRatio / window geometry
// ---------------------------------------------------------------------------
const realDpr = window.devicePixelRatio;
const screenProto = Object.getPrototypeOf(screen);
defineProto(screenProto, screen, 'width', identity.screen.w);
defineProto(screenProto, screen, 'height', identity.screen.h);
defineProto(screenProto, screen, 'availWidth', identity.screen.w);
defineProto(screenProto, screen, 'availHeight', identity.screen.h - 40);
defineProto(screenProto, screen, 'colorDepth', 24);
defineProto(screenProto, screen, 'pixelDepth', 24);
const winProto = Object.getPrototypeOf(window);
// devicePixelRatio is an own property of window in Chromium (unlike most
// window attributes), so patch wherever its descriptor actually lives — a
// getter on the prototype alone would be shadowed by the real own property.
define(Object.getOwnPropertyDescriptor(window, 'devicePixelRatio') ? window : winProto, 'devicePixelRatio', identity.screen.dpr);

// Window geometry vs the claimed screen: clamp position and outer size so a
// window maximized on a real monitor bigger than the claimed screen cannot
// overflow it (outerWidth > screen.availWidth is impossible on real hardware).
const clampTo = (v, max) => Math.max(0, Math.min(v, Math.max(0, max)));
const patchWindowRead = (prop, max) => {
  const target = Object.getOwnPropertyDescriptor(window, prop) ? window : winProto;
  const desc = Object.getOwnPropertyDescriptor(target, prop);
  if (desc && desc.get) {
    const origGet = desc.get;
    defineGetter(target, prop, function () {
      return Math.round(clampTo(origGet.call(window), max));
    });
  }
};
patchWindowRead('screenX', identity.screen.w);
patchWindowRead('screenY', identity.screen.h - 40);
patchWindowRead('outerWidth', identity.screen.w);
patchWindowRead('outerHeight', identity.screen.h - 40);
// screenLeft/screenTop are aliases of the (now patched) screenX/screenY.
for (const [alias, read] of [['screenLeft', () => window.screenX], ['screenTop', () => window.screenY]]) {
  if (alias in window) {
    const target = Object.getOwnPropertyDescriptor(window, alias) ? window : winProto;
    defineGetter(target, alias, read);
  }
}

// matchMedia resolution queries must agree with the claimed dpr: a page asking
// "(min-resolution: 2dppx)" on a claimed-Retina tab has to hear "yes" even
// though the real display is 1x. Rewrite dppx/dpi/device-pixel-ratio values by
// real/claimed before evaluating, and only patch when they actually differ.
if (identity.screen.dpr !== realDpr) {
  const scale = realDpr / identity.screen.dpr;
  const origMatchMedia = window.matchMedia;
  window.matchMedia = disguise(function (query) {
    let q = String(query);
    if (/resolution|device-pixel-ratio/i.test(q)) {
      q = q
        .replace(/(\d+(?:\.\d+)?)(\s*)(dppx)/gi, (_, n, sp) => parseFloat(n) * scale + sp + 'dppx')
        .replace(/(\d+(?:\.\d+)?)(\s*)(dpi)/gi, (_, n, sp) => parseFloat(n) * scale + sp + 'dpi')
        .replace(/((?:-webkit-)?(?:min-|max-)?device-pixel-ratio\s*:\s*)(\d+(?:\.\d+)?)/gi, (_, p, n) => p + parseFloat(n) * scale);
    }
    return origMatchMedia(q);
  }, 'matchMedia');
}

// ---------------------------------------------------------------------------
// Date / Intl — timezone of the fake profile.
// ---------------------------------------------------------------------------
const realOffset = new Date().getTimezoneOffset();
if (realOffset !== identity.timezoneOffset) {
  const shiftMs = (realOffset - identity.timezoneOffset) * 60000;
  const RealDate = Date;
  function PatchedDate(...args) {
    if (!(this instanceof PatchedDate)) return RealDate(...args).toString();
    if (args.length === 0) return new RealDate(RealDate.now() + shiftMs);
    return new RealDate(...args);
  }
  PatchedDate.prototype = RealDate.prototype;
  PatchedDate.parse = RealDate.parse;
  PatchedDate.UTC = RealDate.UTC;
  PatchedDate.now = disguise(() => RealDate.now() + shiftMs, 'now');
  disguise(PatchedDate, 'Date');
  window.Date = PatchedDate;
  // Rely on the shifted clock: any date the page reads reports the fake zone.
  RealDate.prototype.getTimezoneOffset = disguise(function () {
    return identity.timezoneOffset;
  }, 'getTimezoneOffset');
}

// Intl: report the fake timezone in resolvedOptions.
try {
  const origDTF = Intl.DateTimeFormat;
  const shimDTF = function (...args) {
    const opts = args[1] || {};
    opts.timeZone = opts.timeZone || identity.timezone;
    return new origDTF(...[args[0], opts]);
  };
  shimDTF.prototype = origDTF.prototype;
  shimDTF.supportedLocalesOf = origDTF.supportedLocalesOf;
  disguise(shimDTF, 'DateTimeFormat');
  Intl.DateTimeFormat = shimDTF;
  const origResolved = origDTF.prototype.resolvedOptions;
  origDTF.prototype.resolvedOptions = disguise(function () {
    const o = origResolved.call(this);
    o.timeZone = identity.timezone;
    return o;
  }, 'resolvedOptions');
} catch {}

// ---------------------------------------------------------------------------
// Canvas — deterministic seeded noise on every pixel read.
// ---------------------------------------------------------------------------
const CANVAS_AMPLITUDE = 0.006;
const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;

function noisify(data, w, h) {
  for (let i = 0; i < data.length; i += 4) {
    const px = (i / 4) % w, py = (i / 4 / w | 0);
    for (let c = 0; c < 3; c++) {
      const n = hashNoise(px, py, c, identity.noise.canvas);
      data[i + c] = Math.max(0, Math.min(255, data[i + c] + n * 255 * CANVAS_AMPLITUDE));
    }
  }
}

CanvasRenderingContext2D.prototype.getImageData = disguise(function (sx, sy, sw, sh) {
  const imgData = origGetImageData.call(this, sx, sy, sw, sh);
  noisify(imgData.data, imgData.width, imgData.height);
  return imgData;
}, 'getImageData');

// toDataURL / toBlob: draw the noised pixels into a detached scratch canvas
// and serialize THAT, so the real drawing surface is never modified and two
// consecutive reads return identical bytes (fingerprinters check exactly this).
const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
const origToBlob = HTMLCanvasElement.prototype.toBlob;
const scratchCanvases = new WeakMap();
function noisedCopy(canvas) {
  if (!canvas.width || !canvas.height) return canvas;
  let ctx = null;
  try { ctx = canvas.getContext('2d'); } catch {}
  if (!ctx) return canvas;
  let scratch = scratchCanvases.get(canvas);
  if (!scratch || scratch.width !== canvas.width || scratch.height !== canvas.height) {
    scratch = document.createElement('canvas');
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    scratchCanvases.set(canvas, scratch);
  }
  const sctx = scratch.getContext('2d');
  const img = origGetImageData.call(ctx, 0, 0, canvas.width, canvas.height);
  noisify(img.data, img.width, img.height);
  sctx.putImageData(img, 0, 0);
  return scratch;
}
HTMLCanvasElement.prototype.toDataURL = disguise(function (...args) {
  return origToDataURL.call(noisedCopy(this), ...args);
}, 'toDataURL');
HTMLCanvasElement.prototype.toBlob = disguise(function (cb, ...args) {
  return origToBlob.call(noisedCopy(this), cb, ...args);
}, 'toBlob');
// OffscreenCanvas: pages increasingly use it to sidestep the DOM patch. Same
// detached-scratch strategy as toDataURL — the real surface is never written
// to, so repeated reads stay byte-identical (writing the noised pixels back
// would stack noise on noise and fail the double-read check).
if (typeof OffscreenCanvas !== 'undefined') {
  const origOCConvert = OffscreenCanvas.prototype.convertToBlob;
  const origOCTransfer = OffscreenCanvas.prototype.transferToImageBitmap;
  const origOCGetImageData = OffscreenCanvasRenderingContext2D.prototype.getImageData;
  if (origOCGetImageData) {
    OffscreenCanvasRenderingContext2D.prototype.getImageData = disguise(function (...args) {
      const imgData = origOCGetImageData.call(this, ...args);
      noisify(imgData.data, imgData.width, imgData.height);
      return imgData;
    }, 'getImageData');
    // A fresh scratch each time: transferToImageBitmap detaches whatever it
    // transfers, so a cached scratch would be dead after the first call.
    const noisedOffscreenCopy = (canvas) => {
      if (!canvas.width || !canvas.height) return canvas;
      let ctx = null;
      try { ctx = canvas.getContext('2d'); } catch {}
      if (!ctx) return canvas;
      const scratch = new OffscreenCanvas(canvas.width, canvas.height);
      const sctx = scratch.getContext('2d');
      const img = origOCGetImageData.call(ctx, 0, 0, canvas.width, canvas.height);
      noisify(img.data, img.width, img.height);
      sctx.putImageData(img, 0, 0);
      return scratch;
    };
    OffscreenCanvas.prototype.convertToBlob = disguise(function (...args) {
      return origOCConvert.call(noisedOffscreenCopy(this), ...args);
    }, 'convertToBlob');
    OffscreenCanvas.prototype.transferToImageBitmap = disguise(function (...args) {
      return origOCTransfer.call(noisedOffscreenCopy(this), ...args);
    }, 'transferToImageBitmap');
  }
}

// ---------------------------------------------------------------------------
// WebGL — fake vendor/renderer + tiny renderer-level noise on readback.
// ---------------------------------------------------------------------------
const wrapGL = (proto) => {
  const origGetParam = proto.getParameter;
  proto.getParameter = disguise(function (param) {
    // UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL — the extension
    // constants; reported directly since Chromium always enables the ext.
    if (param === 0x9245) return identity.gpu.vendor;
    if (param === 0x9246) return identity.gpu.renderer;
    return origGetParam.call(this, param);
  }, 'getParameter');
};
try { wrapGL(WebGLRenderingContext.prototype); } catch {}
try { wrapGL(WebGL2RenderingContext.prototype); } catch {}

// WebGL readback noise: readPixels output perturbed deterministically.
try {
  const protos = [];
  if (typeof WebGLRenderingContext !== 'undefined') protos.push(WebGLRenderingContext.prototype);
  if (typeof WebGL2RenderingContext !== 'undefined') protos.push(WebGL2RenderingContext.prototype);
  for (const proto of protos) {
    const origReadPixels = proto.readPixels;
    proto.readPixels = disguise(function (x, y, w, h, format, type, pixels) {
      origReadPixels.call(this, x, y, w, h, format, type, pixels);
      if (pixels && (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)) {
        const isRGBA = format === 0x1908;
        if (isRGBA) {
          for (let i = 0; i < pixels.length; i += 4) {
            for (let c = 0; c < 3; c++) {
              const n = hashNoise(x + ((i / 4) % w), y + (i / 4 / w | 0), c, identity.noise.webgl);
              pixels[i + c] = Math.max(0, Math.min(255, Math.round(pixels[i + c] + n * 255 * 0.004)));
            }
          }
        }
      }
    }, 'readPixels');
  }
} catch {}

// ---------------------------------------------------------------------------
// Audio — OfflineAudioContext output perturbed by a seeded constant.
// The same channel always returns the same Float32Array, so keying the
// WeakSet on that array noises each channel exactly once, and the noise
// itself is keyed by the channel index.
// ---------------------------------------------------------------------------
try {
  if (typeof OfflineAudioContext !== 'undefined') {
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    const noisedArrays = new WeakSet();
    AudioBuffer.prototype.getChannelData = disguise(function (channel) {
      const data = origGetChannelData.call(this, channel);
      if (!noisedArrays.has(data)) {
        noisedArrays.add(data);
        const key = identity.noise.audio;
        for (let i = 0; i < data.length; i++) {
          const n = hashNoise(i, channel, 0, key);
          data[i] = data[i] + n * 1e-7 * (data[i] + 1e-7);
        }
      }
      return data;
    }, 'getChannelData');
  }
} catch {}

// ---------------------------------------------------------------------------
// Fonts — local font enumeration and canvas text metrics report only the
// Windows base font set. Sites enumerating via document.fonts.check or
// canvas measureText will see a consistent, common font inventory.
// ---------------------------------------------------------------------------
function isAllowedFont(name) {
  return identity.fonts.some((f) => f.toLowerCase() === name);
}
const FONT_FALLBACK = identity.fontFallback;
const GENERIC_FONT =
  /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|inherit|initial|unset)$/i;

// document.fonts.check — answer from the claim, not the host: a claimed-macOS
// tab must say "Helvetica: yes" even on a Windows machine, and a font outside
// the claimed OS's base set must say "no" even when it really is installed
// (leaking real local installs is the whole point of the probe). A family the
// page itself registered as a webfont gets the real load-state answer.
if (window.document && document.fonts && document.fonts.check) {
  const origCheck = document.fonts.check.bind(document.fonts);
  document.fonts.check = disguise(function (font, text) {
    // Parse the family list out of the CSS font string.
    const m = String(font).match(/^(?:[^/("']+(?:\([^)]*\))?[^/("']*)?(?:\d+(?:\.\d+)?[a-z%]+\s*)*(?:\/\s*\d+(?:\.\d+)?[a-z%]*\s*)?(.*)$/i);
    const families = (m && m[1] || '').split(',');
    const registered = new Set();
    try {
      for (const f of document.fonts) if (f && f.family) registered.add(f.family.trim().toLowerCase());
    } catch {}
    let webfont = false;
    for (const raw of families) {
      const name = raw.trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (!name || GENERIC_FONT.test(name)) continue;
      if (isAllowedFont(name)) continue;
      if (registered.has(name)) {
        webfont = true;
        continue;
      }
      return false;
    }
    return webfont ? origCheck(font, text) : true;
  }, 'check');
}

// measureText: for non-whitelisted families, metrics of the fallback font.
const origMeasureText = CanvasRenderingContext2D.prototype.measureText;
CanvasRenderingContext2D.prototype.measureText = disguise(function (text) {
  const origFont = this.font;
  if (typeof origFont === 'string' && origFont) {
    const sanitized = sanitizeFont(origFont);
    if (sanitized !== origFont) this.font = sanitized;
    try {
      return origMeasureText.call(this, text);
    } finally {
      this.font = origFont;
    }
  }
  return origMeasureText.call(this, text);
}, 'measureText');
function sanitizeFont(font) {
  // The CSS font shorthand puts families last, comma-separated. Replace any
  // family not in the whitelist with the fallback so metrics leak nothing
  // about installed fonts.
  const idx = font.lastIndexOf(',');
  if (idx === -1) {
    // Single family, e.g. "12px Foo" — check the token after the size.
    const m = font.match(/^(.*?\d+(?:\.\d+)?(?:px|pt|em|rem|%|ex|ch|vw|vh)\s+)(.+)$/);
    if (!m) return font;
    const name = m[2].trim().replace(/^["']|["']$/g, '');
    if (!name || GENERIC_FONT.test(name) || isAllowedFont(name.toLowerCase())) return font;
    return m[1] + `"${FONT_FALLBACK}", ` + name.replace(/["']/g, '');
  }
  const families = font.slice(idx + 1).trim();
  if (!families) return font;
  const replaced = families.split(/\s*,\s*/).map((f) => {
    const name = f.replace(/^["']|["']$/g, '').trim();
    if (!name) return f;
    if (GENERIC_FONT.test(name)) return f;
    if (isAllowedFont(name.toLowerCase())) return f;
    return `"${FONT_FALLBACK}"`;
  }).join(', ');
  return font.slice(0, idx + 1) + ' ' + replaced;
}

// queryLocalFonts requires the "local-fonts" permission, which our permission
// handler denies by default — enumeration through it returns an empty list.

// ---------------------------------------------------------------------------
// Canvas font drawing: patch `ctx.font` setter so drawings using
// non-whitelisted fonts silently use the fallback — keeps pixels consistent
// with the metrics lie above.
// ---------------------------------------------------------------------------
const fontDesc = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'font');
if (fontDesc && fontDesc.set) {
  const origSet = fontDesc.set;
  const origGet = fontDesc.get;
  Object.defineProperty(CanvasRenderingContext2D.prototype, 'font', {
    get: origGet,
    set: disguise(function (v) {
      origSet.call(this, typeof v === 'string' ? sanitizeFont(v) : v);
    }, 'font', 'set'),
    configurable: true,
  });
}
