// Deterministic per-tab fake identities: every fingerprintable value derives
// from a seed stored with the tab, so a tab keeps the same fingerprint across
// reloads and restarts, while different tabs look like different machines —
// right down to which operating system they claim to run.
const crypto = require('node:crypto');

// Chrome versions we impersonate. Always at or below the Chromium build we
// actually ship (156) so the network-stack fingerprint (TLS/HTTP2, which we
// deliberately do not touch) stays plausible for the UA we claim.
const CHROME_VERSIONS = ['156.0.8078.48', '156.0.8078.32', '155.0.7971.24'];

// Common CPU core counts, weighted by market share (plausible on any OS).
const CPUS = [4, 8, 8, 8, 12, 16, 6, 4];
// Chrome caps navigator.deviceMemory at 8 GB, so never claim more.
const RAMS = [8, 8, 8, 8, 4, 4, 2];

// Time zones in rough order of visitor volume, paired with locale. Any OS.
const ZONES = [
  { tz: 'Europe/Berlin', locale: 'de-DE', lang: 'de', offset: -60 },
  { tz: 'Europe/London', locale: 'en-GB', lang: 'en-GB', offset: 0 },
  { tz: 'America/New_York', locale: 'en-US', lang: 'en-US', offset: 300 },
  { tz: 'America/Chicago', locale: 'en-US', lang: 'en-US', offset: 360 },
  { tz: 'America/Los_Angeles', locale: 'en-US', lang: 'en-US', offset: 480 },
  { tz: 'Asia/Tehran', locale: 'fa-IR', lang: 'fa', offset: -210 },
  { tz: 'Europe/Paris', locale: 'fr-FR', lang: 'fr', offset: -60 },
  { tz: 'Asia/Tokyo', locale: 'ja-JP', lang: 'ja', offset: -540 },
  { tz: 'Europe/Moscow', locale: 'ru-RU', lang: 'ru', offset: -180 },
  { tz: 'Asia/Dubai', locale: 'en-AE', lang: 'en', offset: -240 },
  { tz: 'Asia/Singapore', locale: 'en-SG', lang: 'en', offset: -480 },
  { tz: 'Australia/Sydney', locale: 'en-AU', lang: 'en', offset: -600 },
  { tz: 'America/Sao_Paulo', locale: 'pt-BR', lang: 'pt', offset: 180 },
  { tz: 'Asia/Seoul', locale: 'ko-KR', lang: 'ko', offset: -540 },
  { tz: 'Europe/Istanbul', locale: 'tr-TR', lang: 'tr', offset: -180 },
  { tz: 'Europe/Amsterdam', locale: 'nl-NL', lang: 'nl', offset: -60 },
  { tz: 'Europe/Stockholm', locale: 'sv-SE', lang: 'sv', offset: -60 },
];

// Fonts every Windows 10/11 box has.
const WINDOWS_FONTS = [
  'Arial', 'Calibri', 'Cambria', 'Cambria Math', 'Comic Sans MS', 'Consolas',
  'Constantia', 'Corbel', 'Courier New', 'Ebrima', 'Franklin Gothic Medium',
  'Gabriola', 'Gadugi', 'Georgia', 'Impact', 'Ink Free', 'Javanese Text',
  'Leelawadee UI', 'Lucida Console', 'Lucida Sans Unicode', 'Malgun Gothic',
  'Marlett', 'Microsoft Himalaya', 'Microsoft JhengHei', 'Microsoft New Tai Lue',
  'Microsoft PhagsPa', 'Microsoft Sans Serif', 'Microsoft Tai Le',
  'Microsoft YaHei', 'Microsoft Yi Baiti', 'MingLiU-ExtB', 'Mongolian Baiti',
  'MS Gothic', 'MV Boli', 'Myanmar Text', 'Nirmala UI', 'Palatino Linotype',
  'Segoe MDL2 Assets', 'Segoe Print', 'Segoe Script', 'Segoe UI',
  'Segoe UI Emoji', 'Segoe UI Historic', 'Segoe UI Symbol', 'SimSun',
  'Sitka', 'Sylfaen', 'Symbol', 'Tahoma', 'Times New Roman', 'Trebuchet MS',
  'Verdana', 'Webdings', 'Wingdings', 'Yu Gothic',
];

// Fonts a stock macOS install ships.
const MAC_FONTS = [
  'Al Nile', 'American Typewriter', 'Andale Mono', 'Apple Color Emoji',
  'AppleGothic', 'Arial', 'Arial Black', 'Arial Hebrew',
  'Arial Rounded MT Bold', 'Avenir', 'Avenir Next', 'Baskerville',
  'Bodoni 72', 'Bradley Hand', 'Chalkboard', 'Chalkduster', 'Charter',
  'Cochin', 'Comic Sans MS', 'Copperplate', 'Courier', 'Courier New',
  'Didot', 'Futura', 'Geneva', 'Georgia', 'Gill Sans', 'Helvetica',
  'Helvetica Neue', 'Hiragino Maru Gothic ProN', 'Hiragino Sans', 'Impact',
  'Lucida Grande', 'Marker Felt', 'Menlo', 'Monaco', 'Mukta Mahee',
  'Optima', 'Palatino', 'Papyrus', 'Rockwell', 'Snell Roundhand',
  'Times New Roman', 'Trebuchet MS', 'Verdana', 'Zapfino',
];

// Fonts a stock Ubuntu/Debian desktop ships.
const LINUX_FONTS = [
  'Cantarell', 'DejaVu Sans', 'DejaVu Sans Condensed', 'DejaVu Sans Mono',
  'DejaVu Serif', 'DejaVu Serif Condensed', 'FreeMono', 'FreeSans',
  'FreeSerif', 'Liberation Mono', 'Liberation Sans',
  'Liberation Sans Narrow', 'Liberation Serif', 'Lohit Devanagari',
  'Noto Color Emoji', 'Noto Mono', 'Noto Sans', 'Noto Sans Arabic',
  'Noto Serif', 'Ubuntu', 'Ubuntu Condensed', 'Ubuntu Mono', 'Ubuntu Sans',
];

// Per-OS profiles, weighted by desktop market share. Everything the page can
// read that differs between operating systems lives here. Screens must be at
// least as large as the app window (1280x820 plus OS chrome) — a claimed
// screen smaller than the real window is an impossible-on-real-hardware tell.
const OSES = [
  {
    id: 'windows', weight: 0.7,
    chPlatform: '"Windows"', uadPlatform: 'Windows', navPlatform: 'Win32',
    platformVersions: ['10.0.0', '15.0.0'], // Win10 vs Win11 (22H2+ reports 15)
    architectures: [['x86', '64']],
    fontFallback: 'Arial',
    screens: [
      { w: 1920, h: 1080, dpr: 1 }, { w: 1920, h: 1080, dpr: 1 },
      { w: 1920, h: 1080, dpr: 1 }, { w: 1536, h: 864, dpr: 1.25 },
      { w: 1600, h: 900, dpr: 1 }, { w: 2560, h: 1440, dpr: 1 },
      { w: 1680, h: 1050, dpr: 1 },
    ],
    fonts: WINDOWS_FONTS,
    gpus: [
      { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00003EA5) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001F82) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics (0x0000164E) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
      { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Series (0x000067DF) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    ],
    ua: (v) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`,
  },
  {
    id: 'macos', weight: 0.2,
    chPlatform: '"macOS"', uadPlatform: 'macOS', navPlatform: 'MacIntel',
    // macOS froze the UA token at 10_15_7 years ago; platformVersion tracks
    // the real release (15 = Sequoia line, 26 = Tahoe line).
    platformVersions: ['14.7.2', '15.3.2', '26.1.0'],
    architectures: [['arm', '64'], ['arm', '64'], ['arm', '64'], ['x86', '64']],
    fontFallback: 'Helvetica',
    screens: [
      { w: 1440, h: 900, dpr: 2 }, { w: 1440, h: 900, dpr: 2 },
      { w: 1512, h: 982, dpr: 2 }, { w: 1728, h: 1117, dpr: 2 },
      { w: 1920, h: 1080, dpr: 1 }, { w: 2560, h: 1440, dpr: 2 },
    ],
    fonts: MAC_FONTS,
    gpus: [
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)' },
      { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics 645, OpenGL 4.1)' },
    ],
    ua: (v) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`,
  },
  {
    id: 'linux', weight: 0.1,
    chPlatform: '"Linux"', uadPlatform: 'Linux', navPlatform: 'Linux x86_64',
    platformVersions: [''], // Chrome reports an empty platformVersion on Linux
    architectures: [['x86', '64']],
    fontFallback: 'Liberation Sans',
    screens: [
      { w: 1920, h: 1080, dpr: 1 }, { w: 1920, h: 1080, dpr: 1 },
      { w: 2560, h: 1440, dpr: 1 }, { w: 3840, h: 2160, dpr: 2 },
      { w: 1600, h: 900, dpr: 1 },
    ],
    fonts: LINUX_FONTS,
    gpus: [
      { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6 (Core Profile) Mesa 24.0.9)' },
      { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) Graphics (ADL GT2), OpenGL 4.6 (Core Profile) Mesa 24.0.9)' },
      { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650, OpenGL 4.6.0 NVIDIA 550.107)' },
      { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 (radeonsi navi23 LLVM 17.0.6), OpenGL 4.6 (Core Profile) Mesa 24.0.9)' },
    ],
    ua: (v) => `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`,
  },
];

// A small PRNG (mulberry32) keyed by the tab seed: same seed, same values,
// stable across reloads; a different seed produces a visibly different machine.
function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate the persistent fake identity for one tab. */
function createIdentity() {
  const seed = crypto.randomBytes(4).readUInt32BE(0);
  return identityFromSeed(seed);
}

/** Recompute the same identity from a stored seed (used on restart). */
function identityFromSeed(seed) {
  const rand = prng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  // Weighted OS pick by market share: most tabs look like Windows, some like
  // macOS, a few like Linux — exactly like a crowd of real visitors.
  let r = rand() * OSES.reduce((s, o) => s + o.weight, 0);
  const os = OSES.find((o) => (r -= o.weight) <= 0) || OSES[0];

  const chrome = pick(CHROME_VERSIONS);
  const screen = pick(os.screens);
  const zone = pick(ZONES);
  const gpu = pick(os.gpus);
  const [architecture, bitness] = pick(os.architectures);

  // Extra languages some users have, e.g. ['en-US','en','de'] for a German box.
  const languages = [zone.locale];
  if (zone.lang !== 'en' && rand() < 0.25) languages.push('en-US', 'en');
  else if (rand() < 0.2) languages.push('en');

  const major = chrome.split('.')[0];
  const ua = os.ua(chrome);

  // User-Agent Client Hints: low-entropy values pages read synchronously.
  // Full versions for the current Chrome line; brands kept consistent with UA.
  const brands = [
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
    { brand: 'Not?A_Brand', version: '24' },
  ];

  return {
    seed,
    os: os.id,
    ua,
    brands,
    platform: os.navPlatform,
    uadPlatform: os.uadPlatform,
    chPlatform: os.chPlatform, // sec-ch-ua-platform header value, with quotes
    platformVersion: pick(os.platformVersions),
    architecture,
    bitness,
    chrome,
    languages,
    locale: zone.locale,
    timezone: zone.tz,
    timezoneOffset: zone.offset, // minutes to ADD to local time to get UTC (as JS defines it)
    hardwareConcurrency: pick(CPUS),
    deviceMemory: pick(RAMS),
    screen,
    gpu,
    fonts: os.fonts,
    fontFallback: os.fontFallback,
    // Per-tab canvas/audio noise keys, also seed-derived and stable.
    noise: {
      canvas: seed,
      audio: Math.floor(rand() * 0xFFFFFFFF),
      webgl: Math.floor(rand() * 0xFFFFFFFF),
    },
  };
}

module.exports = { createIdentity, identityFromSeed, WINDOWS_FONTS };
