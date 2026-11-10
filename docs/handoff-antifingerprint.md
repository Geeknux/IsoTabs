# Handoff: Anti-Fingerprinting Work on IsoTabs

Status document for continuing this work with another model/session.
Updated 2026-11-10 (previous version 2026-11-08). Paths relative to the repo
root (`D:\projects\IsoTabs`).

## Project

IsoTabs: an Electron 45 (Chromium 156) browser where every tab is an isolated,
persistent session (own partition `persist:tab-<uuid>` under
`userData/Partitions/tab-<uuid>`). Pure Electron, no other runtime deps.
Run with `npm install && npm start` (`npx electron .`). Build: `npm run dist`.

The user's goal (this workstream): **no site or server should be able to collect
the browser's real fingerprint, while never detecting it is automated/headless —
including the real installed system fonts.** Each tab must present a *different*
fake identity, and each tab's identity must be *stable* across reloads/restarts
(changing fingerprints are themselves a bot signal).

## What exists — ALL DONE, tested

### 1. `src/identity.js` — deterministic per-tab fake identity

Derived from a 32-bit seed stored in `tabs.json` (`seed` field per tab).
Regenerating from the same seed yields the exact same identity. NEW
(2026-11-10, later that day): the identity now includes a **random operating
system per tab** — Windows 70% / macOS 20% / Linux 10% (market-share weights),
and everything OS-dependent is per-profile:

- UA (`Windows NT 10.0; Win64; x64` / `Macintosh; Intel Mac OS X 10_15_7` /
  `X11; Linux x86_64`), `navigator.platform` (`Win32`/`MacIntel`/
  `Linux x86_64`), `sec-ch-ua-platform` (identity.chPlatform, with quotes —
  main.js uses it for the header), `userAgentData.platform` (identity.uadPlatform).
- platformVersion (Win `10.0.0`/`15.0.0`, mac real releases, Linux `""` —
  Chrome reports empty on Linux), architecture/bitness (mac mostly `arm`/`64`).
- Per-OS font whitelists (~55 Windows / ~46 macOS / ~23 Linux fonts) with a
  per-OS fallback (`Arial` / `Helvetica` / `Liberation Sans`).
- Per-OS GPU strings (D3D11 ANGLE / ANGLE Metal Apple M-series / Mesa OpenGL)
  and per-OS screens (mac includes Retina dpr 2, Linux includes 4K@2; all
  screens ≥ 1536x864 so the 1280x820 window always fits).
- Chrome 155/156 versions (≤ shipped Chromium 156), languages + timezone+locale
  pair (17 zones incl. `Asia/Tehran`), CPU cores, deviceMemory ≤ 8, per-tab
  canvas/audio/webgl noise keys — unchanged.

### 2. `src/spoof.js` — preload injected into every tab (and popup)

`contextIsolation: false, sandbox: true, nodeIntegration: false`. Gets its
tab's identity via `ipcRenderer.sendSync('spoof-config')` — main resolves the
tab by the sender's session partition. Patches, before any page script runs:

- **Native disguise layer (NEW 2026-11-10):** `Function.prototype.toString`
  is replaced with a WeakMap lookup — every function/getter this file patches
  reports `function <name>() { [native code] }` (with correct `get`/`set`
  prefixes for accessors and matching `fn.name`); everything else passes
  through to the real toString. Without this, any
  `fn.toString()` check flagged the patched environment.
- **Prototype-level patching (NEW):** spoofed attributes live as getters on
  `Navigator.prototype` / `Screen.prototype` / `Window.prototype` (where
  Chrome keeps them), not as own properties on the instances — own props on
  `navigator` were themselves a shape tell. Instance fallback only if a
  prototype refuses.
- `navigator`: `userAgent` (real one leaks `Electron/45`), `platform`,
  `languages` (fresh frozen array per access, like Chrome's FrozenArray),
  `language`, `hardwareConcurrency`, `deviceMemory`, `webdriver=false`,
  `userAgentData` incl. `getHighEntropyValues`, `plugins`/`mimeTypes`
  (5 PDF plugins exactly like Chrome), `getBattery` (stable mid-charge,
  prototyped as a real `BatteryManager`), `keyboard.getLayoutMap` (US layout).
- `window.chrome` (`chrome.app` etc. — Electron omits it; well-known tell).
- `screen.*`, `devicePixelRatio` (NEW: it is an OWN property of window in
  Chromium — patching `Window.prototype` gets shadowed; patch wherever the
  descriptor lives), `permissions.query` fallback (patched on
  `Permissions.prototype`).
- Window geometry vs the claimed screen (NEW): `screenX`/`screenY`/
  `outerWidth`/`outerHeight` clamp into the claimed screen so a window
  maximized on a bigger real monitor cannot overflow it;
  `screenLeft`/`screenTop` alias the patched values.
- `matchMedia` (NEW): resolution/`-webkit-device-pixel-ratio` queries are
  rewritten by real/claimed dpr before evaluating, so media queries agree
  with the spoofed `devicePixelRatio` (only patched when they differ).
- `mediaDevices.enumerateDevices` (NEW): returns a stable per-tab fake
  inventory in Chrome's pre-permission shape (kinds only, empty
  ids/labels/groupId) — real hardware counts were a fingerprint.
- Date/Intl timezone: shifted `Date` + `getTimezoneOffset` +
  `Intl.DateTimeFormat` resolvedOptions → the identity's timezone.
- Canvas: `getImageData`, `toDataURL`, `toBlob` on a detached scratch canvas
  so reads are idempotent. Same strategy for `OffscreenCanvas`
  (`getImageData`/`convertToBlob`/`transferToImageBitmap` use a fresh scratch
  per call — FIXED 2026-11-10: they used to write noise back onto the real
  canvas, stacking noise on noise and failing the double-read check).
- WebGL: `getParameter` returns fake UNMASKED vendor/renderer (0x9245/0x9246);
  `readPixels` gets tiny seeded noise.
- Audio: `AudioBuffer.getChannelData` seeded noise keyed per channel (FIXED
  2026-11-10: the old `__noised` flag on the buffer noised only the first
  channel requested; now a WeakSet on the returned Float32Array noises each
  channel exactly once, keyed by channel index).
- Fonts (the user's explicit ask): `document.fonts.check` answers from the
  CLAIMED OS, not the host (NEW: a claimed-mac tab says "Helvetica: yes" on a
  Windows machine; "B Nazanin" says no even when really installed — only
  families the page registered as webfonts get the real load-state answer);
  `ctx.font` setter + `measureText` sanitize the family list, replacing
  non-whitelisted fonts with the identity's per-OS `fontFallback`.
  `queryLocalFonts` needs the `local-fonts` permission which is denied in
  `configureSession`.

### 3. `src/main.js`

- Tabs carry `identity` (runtime) + `seed`, `proxy` (persisted in `tabs.json`).
- **WebRTC (NEW):** two halves that together make WebRTC report the tab's IP:
  - `app.commandLine.appendSwitch('force-webrtc-ip-handling-policy',
    'disable_non_proxied_udp')` at the top — relay-only candidate gathering,
    so STUN can never leak the real public IP around a tab's proxy (Chromium
    does not route STUN/UDP through proxies; global switch, no per-session
    policy exists in Electron).
  - **Proxy exit-IP presentation:** for proxied tabs, main fetches the
    proxy's public IP through the tab's own session (`fetchExitIp`, via
    api.ipify.org / api64.ipify.org, 6s timeout each; awaited AFTER
    `setProxy` so the lookup cannot go direct and return the real IP) and
    hands it to the preload as `identity.webrtcIp`. spoof.js then replaces
    `RTCPeerConnection`: real candidate events are swallowed
    (constructor-registered listener + stopImmediatePropagation; relay/TURN
    candidates pass through), a deterministic fake set is dispatched first
    (mDNS host UDP+TCP, srflx with the exit IP; ports/foundation/mdns name
    derived from the seed), `localDescription/currentDescription` SDP gets
    the fake candidate lines injected, and `getStats` rewrites srflx
    local-candidate addresses. Without a proxy (or if the echo lookup
    failed) nothing is presented and WebRTC stays fully hidden.
- `configureSession(ses, identity, proxy)`: per-tab UA + `acceptLanguages`,
  rewrites `sec-ch-ua` / `sec-ch-ua-mobile` / `sec-ch-ua-platform` headers via
  `onBeforeSendHeaders` (platform from `identity.chPlatform` — matches the
  claimed OS), applies `ses.setProxy` when a proxy is set, denies
  `local-fonts` explicitly.
- `spoof-config` sync IPC handler maps sender partition → tab identity.
- Popups share the tab's partition *and* get the spoof preload.
- `setTabProxy(id, proxy)` — validates (`PROXY_URL_RE` scheme allowlist +
  `PROXY_LIST_RE` per-protocol lists), applies live, reloads, persists.
- Proxy UI is COMPLETE (was the missing piece on 2026-11-08):
  - `src/preload.js` exposes `onPrompt` / `sendPromptValue`.
  - `src/renderer` shows a dark-theme modal (`#prompt` in index.html):
    Enter/Save commits, Escape/Cancel/backdrop-click sends **null**, and main
    skips `onSave` for null — `""` is a real answer (empty proxy = direct).
    The active tab's WebContentsView is HIDDEN while the prompt is up
    (promptValue/dismissPrompt/restorePromptView in main.js): the page view
    natively overlays the UI renderer, so without this the modal is painted
    over by the page and invisible on any tab with content loaded (bug found
    by the user 2026-11-10). Tab switches dismiss the prompt via the
    `ui:close-prompt` channel.
  - `pushState` sends `proxy`; the tab shows a small proxy badge
    (`.tab.proxied .icon::after`) and tooltip line.

### Verified by automated probes (harnesses deleted after use)

Two throwaway harnesses: the spoof probe ALL GREEN across 15 seeds covering
all three OS profiles (windows ×9, macos ×2, linux ×2, 39 checks each; one
iteration caught the `devicePixelRatio` own-property bug — dpr≠1 seeds failed
until the patch target was fixed), the prompt flow (12 checks), and a WebRTC
probe (9 checks × 4 seeds: fake srflx delivered with the claimed IP, real
host/srflx candidates never reach the page — verified both with and without
the relay-only policy —, SDP injection keeps parseable, srflx stats rewritten,
null end-of-candidates still arrives after the fakes):

- Spoof probe: boots a `WebContentsView` with the spoof preload +
  `ipcMain.on('spoof-config')` stub, runs an inline async JS probe, main
  parses `PROBE_RESULT <json>` from `console-message`. Assertions: UA + OS
  claim, platform, languages, hwc, dm ≤ 8, webdriver, 5 plugins / 2 mimes,
  chrome.app, uad brands/platform, getHighEntropyValues
  (platform/platformVersion/architecture/bitness/uaFullVersion), screen/dpr,
  matchMedia dppx consistency, window-geometry-in-screen, tz pair,
  claim-driven font check + measureText fallback, canvas
  toDataURL/getImageData idempotency + determinism, OffscreenCanvas
  convertToBlob/getImageData idempotency + transferToImageBitmap not mutating
  the canvas, audio per-channel noise + cross-render stability + idempotent
  reads, fake enumerateDevices shape, native toString for patched
  fns/getters/setters/Date/toString itself, passthrough for page fns,
  no spoofed own-props on navigator, GPU strings.
- Prompt flow: real `preload.js` + renderer in a hidden BrowserWindow, stubbed
  ipc handlers; drives open → prefill → Enter-save → reopen → Escape-null →
  backdrop-cancel → empty-string-save.

Re-creating the harnesses — gotchas learned the hard way:

- `navigator.userAgentData` is a **[SecureContext] API: undefined on
  about:blank**. Serve a local page (`http.createServer` on 127.0.0.1:0) and
  load that, or the probe throws.
- Electron 45's `console-message` emits an object — use `ev.message ?? ...`.
- A syntax error in the harness main script makes Electron show a native
  error dialog and **hang forever with no console output** — run
  `node --check` on the harness first, and log to a file (stdout is
  block-buffered until exit).
- Add a 20s timeout in the harness.
- The renderer CSP (`script-src 'self'`) does not block
  `executeJavaScript`; `KeyboardEvent`/`MouseEvent` dispatch works for the
  modal's key handling.

## Known limitations / honest caveats (tell the user, don't silently ignore)

- **DOM-span font enumeration** (site creates spans with different
  `font-family`, reads `offsetWidth`) is done by the render engine, not JS —
  the JS layer cannot fully hide real installed fonts. `ctx.font` +
  `measureText` are covered; CSS/DOM-based detection leaks. A complete fix on
  Windows would require system-level font virtualization per process; on
  Linux a custom fontconfig restricting the whitelist would work.
- **IP**: without a per-tab proxy all tabs share one IP and are linkable.
  The proxy plumbing + UI are complete; proxies themselves are the user's to
  supply.
- **WebRTC trade-off**: `disable_non_proxied_udp` means no host/srflx
  candidates — WebRTC still works only via TURN relay. Sites can observe
  "no direct candidates" (VPN-like; many VPN users look the same), and direct
  P2P video calls need a TURN server. For proxied tabs the fake srflx
  candidate covers IP-consistency tests; the fake candidates cannot actually
  carry media (a real connection still needs TURN). If a use case ever needs
  real P2P, remove the switch in `src/main.js` and accept the STUN leak.
  The exit-IP echo services see only the proxy IP; if both lookups fail
  (unusual), WebRTC stays hidden rather than presenting a wrong address.
- **Claimed-OS vs host leftovers**: the claimed OS drives UA, client hints,
  fonts, GPU strings — but host-level leftovers can contradict it: the TLS
  stack is the same Windows build everywhere (fine — same Chromium), and
  `window.innerWidth/innerHeight` are NOT spoofed (layout correctness), so a
  maximized window on a real monitor larger than the claimed screen can still
  show `innerWidth > screen.availWidth`. outer*/position are clamped.
- TLS/HTTP2 (JA3/JA4) fingerprint is intentionally NOT spoofed — Chromium's
  own stack is the most plausible thing to present; only UA-level consistency
  was faked around it.
- `Date` timezone spoofing shifts the clock; code that compares `Date.now()`
  with server time can notice the skew. Consider making the identity timezone
  match the proxy's exit IP region when both are known (not done).
- A tab's OS claim, timezone and languages are independent random picks; a
  proxy exit country that contradicts them (e.g. German proxy + `Asia/Tehran`
  timezone) is itself a signal. Matching them when a proxy is set is future
  work.
- The spoof preload runs with `contextIsolation: false` — sandbox stays on
  and it only has the one `spoof-config` IPC channel, but flag this design
  point in any future security review. The browser UI (`preload.js`) still
  uses contextIsolation.
- The disguise layer covers `Function.prototype.toString`; it does not make
  the fake `plugins` array's entries real `Plugin` instances, nor the battery
  object indistinguishable at every level (it is a BatteryManager-prototyped
  plain object). Deeply paranoiac sites with custom heuristics may still find
  shape differences.
- Changing the identity tables (OSES/screens/fonts/GPUS/ZONES…) shifts every
  existing tab's fingerprint once, since only the seed is persisted. This
  already happened twice on 2026-11-10 (RAMS clamp + 1280x720 removal, then
  the per-OS rework).

## Repo state (at time of writing)

- Branch `main`, base commit `ea32784` (v1.0.1).
- Uncommitted: `src/main.js`, `src/preload.js`, `src/renderer/*` modified;
  `src/identity.js`, `src/spoof.js`, `docs/handoff-antifingerprint.md` new.
- `package.json` bumped to `1.1.0`.
- Commit message suggestion when done:
  `Spoof a stable per-tab identity (anti-fingerprinting) with per-tab proxy`

## Where things are in the files

- `src/main.js`: WebRTC switch (top, after SEARCH_URL), `configureSession`
  (~line 440), `ensureView` (~line 266), `spoof-config` handler (~line 790),
  `setTabProxy` + `PROXY_URL_RE`/`PROXY_LIST_RE` (~line 400),
  `showTabMenu`/`promptValue`/`pendingPrompt` (end of file area),
  `on('ui:prompt-value')` cancel handling right after `promptValue`.
- `src/identity.js`: `OSES` profiles + per-OS font lists, `createIdentity()`,
  `identityFromSeed(seed)`, `WINDOWS_FONTS` export.
- `src/spoof.js`, ordered top-to-bottom — native-disguise (WeakMap +
  patched `Function.prototype.toString` + `disguise()`) → helpers
  (`hashNoise`, `defineGetter`/`define`/`defineProto`) → navigator →
  userAgentData → plugins → battery/keyboard → mediaDevices.enumerateDevices →
  window.chrome → permissions → screen/dpr/window-geometry/matchMedia →
  Date/Intl → canvas → OffscreenCanvas → WebGL → audio → fonts
  (`isAllowedFont`, claim-driven `document.fonts.check`, `measureText`/
  `sanitizeFont`, `ctx.font` setter).
- `src/renderer/renderer.js`: prompt modal at "one-field prompt" section
  (bottom); proxy badge in `updateTabEl`.
