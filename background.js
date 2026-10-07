/* Pin Sheet service worker: download queue, file checks, video fallback, right-click menu. */
'use strict';

const PIN_PAGES = [
  '*://*.pinterest.com/*', '*://*.pinterest.co.uk/*', '*://*.pinterest.ca/*', '*://*.pinterest.com.au/*',
  '*://*.pinterest.de/*', '*://*.pinterest.fr/*', '*://*.pinterest.es/*', '*://*.pinterest.it/*',
  '*://*.pinterest.jp/*', '*://*.pinterest.co.kr/*', '*://*.pinterest.com.mx/*', '*://*.pinterest.nz/*',
  '*://*.pinterest.ph/*', '*://*.pinterest.pt/*', '*://*.pinterest.se/*', '*://*.pinterest.ch/*',
  '*://*.pinterest.at/*', '*://*.pinterest.cl/*', '*://*.pinterest.dk/*', '*://*.pinterest.ie/*',
];
const CONCURRENCY = 4;
const FILE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_REBUILT_VIDEO = 150 * 1024 * 1024;

const jobs = new Map();
let bulkJobs = 0;

/* ---------- setup ---------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'pinsheet-pin',
      title: 'Download this pin',
      contexts: ['link', 'image', 'video'],
      documentUrlPatterns: PIN_PAGES,
    });
  });
  setDownloadBubble(true);
});
chrome.runtime.onStartup.addListener(() => setDownloadBubble(true));

function pinIdFromUrl(url) {
  const m = String(url || '').match(/\/pin\/(?:[^/?#]*--)?(\d{5,})/);
  return m ? m[1] : null;
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id === undefined || tab.id < 0) return;
  const target = { frameId: info.frameId || 0 };
  const linked = pinIdFromUrl(info.linkUrl);
  const onPage = pinIdFromUrl(info.pageUrl);
  let msg = null;
  if (linked) msg = { type: 'download-pin', id: linked };
  else if (onPage && (info.mediaType === 'video' || !info.srcUrl)) msg = { type: 'download-pin', id: onPage };
  else if (info.srcUrl && /pinimg\.com/i.test(info.srcUrl)) msg = { type: 'download-image', src: info.srcUrl, pageId: onPage };
  else if (onPage) msg = { type: 'download-pin', id: onPage };
  if (msg) chrome.tabs.sendMessage(tab.id, msg, target).catch(() => {});
});

/* ---------- messages from pages ---------- */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pinsheet') return;
  port.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'start') startJob(msg.jobId, msg.items || [], port);
    else if (msg.type === 'cancel') {
      const job = jobs.get(msg.jobId);
      if (job) job.cancelled = true;
    } else if (msg.type === 'show' && msg.downloadId !== undefined) {
      try { chrome.downloads.show(msg.downloadId); } catch (_) { chrome.downloads.showDefaultFolder(); }
    }
    // 'ping' needs no answer: receiving it keeps this worker awake during long jobs.
  });
  port.onDisconnect.addListener(() => {
    for (const job of jobs.values()) if (job.port === port) job.port = null;
  });
});

function post(job, type) {
  if (!job.port) return;
  try {
    job.port.postMessage({
      type, jobId: job.id, done: job.done, failed: job.failed, total: job.items.length,
      errors: type === 'done' ? job.errors.slice(0, 200) : undefined,
      lastDownloadId: job.lastDownloadId, cancelled: job.cancelled,
    });
  } catch (_) {
    job.port = null;
  }
}

/* ---------- job runner ---------- */

async function startJob(jobId, items, port) {
  const job = { id: jobId, items, port, done: 0, failed: 0, errors: [], cancelled: false, lastDownloadId: null };
  jobs.set(jobId, job);
  const bulk = items.length > 3;
  if (bulk && bulkJobs++ === 0) setDownloadBubble(false);
  let next = 0;
  async function worker() {
    while (!job.cancelled && next < items.length) {
      const item = items[next++];
      try {
        job.lastDownloadId = await saveItem(item);
        job.done++;
      } catch (err) {
        job.failed++;
        job.errors.push({ label: item.label || 'File', reason: (err && err.message) || 'Download failed' });
      }
      post(job, 'progress');
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  } finally {
    if (bulk && --bulkJobs === 0) setDownloadBubble(true);
    post(job, 'done');
    jobs.delete(jobId);
  }
}

async function saveItem(item) {
  const src = await resolveSource(item);
  let base = item.path;
  let id;
  try {
    id = await download({ url: src.url, filename: `${base}.${src.ext}`, conflictAction: 'overwrite', saveAs: false });
  } catch (err) {
    if (!/filename/i.test(err.message) || !item.safePath) throw err;
    base = item.safePath;
    id = await download({ url: src.url, filename: `${base}.${src.ext}`, conflictAction: 'overwrite', saveAs: false });
  }
  // Some streamed videos keep their sound in a separate file. Save it next to the video.
  if (src.extra) {
    await download({ url: src.extra.url, filename: `${base}${src.extra.suffix}.${src.extra.ext}`, conflictAction: 'overwrite', saveAs: false })
      .catch(() => {});
  }
  return id;
}

async function resolveSource(item) {
  const urls = item.urls || [];
  if (urls.length === 1 && !item.verify) return { url: urls[0], ext: extOf(urls[0]) || 'jpg' };
  for (const url of urls) {
    const type = await probe(url);
    if (type) return { url, ext: extOf(url) || extFromType(type) };
  }
  for (const hls of item.hls || []) {
    const rebuilt = await videoFromHls(hls).catch(() => null);
    if (rebuilt) return rebuilt;
  }
  throw new Error(urls.length || (item.hls || []).length ? 'Pinterest no longer serves this file' : 'No image or video found');
}

/* ---------- helpers ---------- */

function extOf(url) {
  const m = String(url || '').split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i);
  if (!m) return '';
  const ext = m[1].toLowerCase();
  if (ext === 'jpeg') return 'jpg';
  if (ext === 'cmfv' || ext === 'm4s' || ext === 'm4v') return 'mp4';
  return ext;
}

function extFromType(type) {
  if (/jpe?g/.test(type)) return 'jpg';
  if (/png/.test(type)) return 'png';
  if (/gif/.test(type)) return 'gif';
  if (/webp/.test(type)) return 'webp';
  if (/mp4|video/.test(type)) return 'mp4';
  return 'bin';
}

async function probe(url) {
  try {
    let r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (r.status === 405 || r.status === 501) {
      r = await fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
      if (r.body) r.body.cancel().catch(() => {});
    }
    if (!r.ok) return null;
    const type = (r.headers.get('content-type') || '').toLowerCase();
    if (/text\/html|xml|json/.test(type)) return null;
    return type || 'application/octet-stream';
  } catch (_) {
    return null;
  }
}

const waiters = new Map();

chrome.downloads.onChanged.addListener((delta) => {
  const w = waiters.get(delta.id);
  if (!w || !delta.state) return;
  if (delta.state.current === 'complete') settle(delta.id, null);
  else if (delta.state.current === 'interrupted') settle(delta.id, readableError(delta.error && delta.error.current));
});

function settle(id, error) {
  const w = waiters.get(id);
  if (!w) return;
  waiters.delete(id);
  clearTimeout(w.timer);
  if (error) w.reject(new Error(error));
  else w.resolve(id);
}

function download(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (id) => {
      const err = chrome.runtime.lastError;
      if (err || id === undefined) return reject(new Error((err && err.message) || 'Chrome refused the download'));
      const timer = setTimeout(() => settle(id, 'Took too long to download'), FILE_TIMEOUT_MS);
      waiters.set(id, { resolve, reject, timer });
      // A tiny file can finish before we start listening.
      chrome.downloads.search({ id }, (found) => {
        const d = found && found[0];
        if (!d) return;
        if (d.state === 'complete') settle(id, null);
        else if (d.state === 'interrupted') settle(id, readableError(d.error));
      });
    });
  });
}

function readableError(code) {
  const map = {
    SERVER_FORBIDDEN: 'Pinterest refused the file',
    SERVER_BAD_CONTENT: 'Pinterest no longer serves this file',
    SERVER_FAILED: 'Pinterest server error',
    NETWORK_FAILED: 'Network error',
    NETWORK_TIMEOUT: 'Network timed out',
    NETWORK_DISCONNECTED: 'Lost connection',
    FILE_NO_SPACE: 'Disk is full',
    FILE_ACCESS_DENIED: 'Can’t write to the Downloads folder',
    FILE_NAME_TOO_LONG: 'File name too long',
    USER_CANCELED: 'Cancelled',
  };
  return map[code] || (code ? `Download failed (${code})` : 'Download failed');
}

function setDownloadBubble(enabled) {
  // Hides Chrome's download bubble during bulk saves so it doesn't pop up for every file.
  try {
    if (chrome.downloads.setUiOptions) chrome.downloads.setUiOptions({ enabled }).catch(() => {});
  } catch (_) { /* older Chrome */ }
}

/* ---------- HLS fallback (only when no MP4 exists) ---------- */

async function getText(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function getBytes(url, range) {
  const headers = range ? { Range: `bytes=${range[0]}-${range[1]}` } : {};
  const r = await fetch(url, { headers, cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

function parseMaster(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const out = [];
  lines.forEach((line, i) => {
    if (!line.startsWith('#EXT-X-STREAM-INF')) return;
    const bw = Number((line.match(/[:,]BANDWIDTH=(\d+)/) || [])[1] || 0);
    let j = i + 1;
    while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
    if (j < lines.length) out.push({ bw, url: new URL(lines[j], base).href });
  });
  return out.sort((a, b) => b.bw - a.bw);
}

function toRange(spec, fallbackStart) {
  const [len, off] = spec.split('@');
  const start = off !== undefined ? Number(off) : fallbackStart;
  return [start, start + Number(len) - 1];
}

function parseMedia(text, base) {
  let init = null;
  let pending = null;
  const segs = [];
  const ends = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-KEY') && !/METHOD=NONE/.test(line)) throw new Error('Encrypted video');
    if (line.startsWith('#EXT-X-MAP')) {
      const uri = (line.match(/URI="([^"]+)"/) || [])[1];
      const br = (line.match(/BYTERANGE="([^"]+)"/) || [])[1];
      if (uri) {
        const url = new URL(uri, base).href;
        init = { url, range: br ? toRange(br, 0) : null };
        if (init.range) ends[url] = init.range[1] + 1;
      }
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pending = line.slice('#EXT-X-BYTERANGE:'.length);
    } else if (!line.startsWith('#')) {
      const url = new URL(line, base).href;
      let range = null;
      if (pending) {
        range = toRange(pending, ends[url] || 0);
        ends[url] = range[1] + 1;
        pending = null;
      }
      segs.push({ url, range });
    }
  }
  return { init, segs };
}

function audioUri(masterText, base) {
  for (const raw of masterText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('#EXT-X-MEDIA:') || !/TYPE=AUDIO/.test(line)) continue;
    const uri = (line.match(/URI="([^"]+)"/) || [])[1];
    if (uri) return new URL(uri, base).href;
  }
  return null;
}

// The one file behind a playlist, when the whole stream lives in a single file.
function singleFile(parsed) {
  const files = new Set(parsed.segs.map((s) => s.url));
  if (parsed.init) files.add(parsed.init.url);
  return parsed.segs.length && files.size === 1 ? [...files][0] : null;
}

async function videoFromHls(masterUrl) {
  let mediaUrl = masterUrl;
  let audioUrl = null;
  let text = await getText(masterUrl);
  if (/#EXT-X-STREAM-INF/.test(text)) {
    const variants = parseMaster(text, masterUrl);
    if (!variants.length) return null;
    audioUrl = audioUri(text, masterUrl);
    mediaUrl = variants[0].url;
    text = await getText(mediaUrl);
  }
  const parsed = parseMedia(text, mediaUrl);
  const { init, segs } = parsed;
  if (!segs.length) return null;
  // Pinterest packs most streams as one fragmented MP4 file: download it whole.
  const whole = singleFile(parsed);
  if (whole) {
    const out = { url: whole, ext: 'mp4' };
    if (audioUrl) {
      const audio = await getText(audioUrl).then((t) => singleFile(parseMedia(t, audioUrl))).catch(() => null);
      if (audio) out.extra = { url: audio, ext: 'm4a', suffix: '_audio' };
    }
    return out;
  }

  const isTs = !init && segs.every((s) => /\.ts$/i.test(s.url.split(/[?#]/)[0]));
  const parts = [];
  let size = 0;
  for (const part of (init ? [init] : []).concat(segs)) {
    const bytes = await getBytes(part.url, part.range);
    size += bytes.length;
    if (size > MAX_REBUILT_VIDEO) throw new Error('Video too large');
    parts.push(bytes);
  }
  const joined = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { joined.set(p, at); at += p.length; }
  return { url: toDataUrl(joined, isTs ? 'video/mp2t' : 'video/mp4'), ext: isTs ? 'ts' : 'mp4' };
}

function toDataUrl(bytes, type) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  return `data:${type};base64,${btoa(bin)}`;
}

if (typeof module !== 'undefined') module.exports = { parseMaster, parseMedia, extOf, pinIdFromUrl, audioUri, singleFile };
