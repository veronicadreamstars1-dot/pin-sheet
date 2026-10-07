/* Pin Sheet content script: hover buttons, board picker, Pinterest data calls. */
(() => {
  'use strict';
  if (globalThis.__pinSheetLoaded) return;
  globalThis.__pinSheetLoaded = true;

  const M = globalThis.PinMedia;
  const DEFAULTS = { root: 'Pinterest', naming: 'title', sectionFolders: true, hoverButton: true };
  let settings = { ...DEFAULTS };

  /* ================= helpers ================= */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const plural = (n, word, many) => `${Number(n || 0).toLocaleString()} ${n === 1 ? word : many || word + 's'}`;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }

  const SVG = 'http://www.w3.org/2000/svg';
  const ICONS = {
    down: { d: ['M12 4v11', 'M7 10.5l5 5 5-5', 'M5 20h14'] },
    check: { d: ['M5 12.5l4.5 4.5L19 7.5'], w: 2.6 },
    close: { d: ['M6 6l12 12', 'M18 6 6 18'] },
    play: { d: ['M8 5.8v12.4a.8.8 0 0 0 1.2.7l10-6.2a.8.8 0 0 0 0-1.4l-10-6.2a.8.8 0 0 0-1.2.7z'], fill: true },
    alert: { d: ['M12 7.5v6', 'M12 17h.01'], w: 2.6 },
  };
  function icon(name, size = 18) {
    const def = ICONS[name];
    const svg = document.createElementNS(SVG, 'svg');
    const attrs = {
      viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true',
      fill: def.fill ? 'currentColor' : 'none', stroke: def.fill ? 'none' : 'currentColor',
      'stroke-width': def.w || 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
    for (const d of def.d) {
      const p = document.createElementNS(SVG, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }

  function extensionAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  /* ================= settings ================= */

  try {
    chrome.storage.sync.get(DEFAULTS, (s) => { settings = { ...DEFAULTS, ...s }; });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const k of Object.keys(changes)) settings[k] = changes[k].newValue;
      if (!settings.hoverButton) hideHover();
    });
  } catch (_) { /* extension reloaded */ }

  function rootParts() {
    return String(settings.root || 'Pinterest').split('/').map((s) => M.cleanPart(s)).filter(Boolean);
  }
  function dirPath(...parts) {
    const all = rootParts().concat(parts.map((p) => M.cleanPart(p)).filter(Boolean));
    return (all.length ? all : ['Pinterest']).join('/');
  }

  /* ================= Pinterest data ================= */

  class ApiError extends Error {
    constructor(status, message) {
      super(message || `Pinterest returned an error (${status})`);
      this.status = status;
    }
  }

  async function pws(resource, options, sourceUrl, handler) {
    const params = new URLSearchParams({
      source_url: sourceUrl,
      data: JSON.stringify({ options, context: {} }),
      _: String(Date.now()),
    });
    let status = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      let r;
      try {
        r = await fetch(`/resource/${resource}Resource/get/?${params}`, {
          credentials: 'include',
          headers: {
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
            'X-Pinterest-AppState': 'active',
            'X-Pinterest-Source-Url': sourceUrl,
            'X-Pinterest-PWS-Handler': handler || 'www/[username]/[slug].js',
          },
        });
      } catch (_) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      status = r.status;
      if (r.status === 429 || r.status >= 500) {
        await sleep(1500 * 2 ** attempt);
        continue;
      }
      const json = await r.json().catch(() => null);
      const res = json && json.resource_response;
      if (!r.ok || !res) throw new ApiError(r.status, res && res.message);
      return res;
    }
    throw new ApiError(status, status === 429
      ? 'Pinterest is limiting requests. Wait a minute and try again.'
      : 'Couldn’t reach Pinterest. Check your connection and try again.');
  }

  async function* pages(resource, options, sourceUrl, handler) {
    let bookmark = null;
    for (let i = 0; i < 1000; i++) {
      const res = await pws(resource, bookmark ? { ...options, bookmarks: [bookmark] } : options, sourceUrl, handler);
      const data = Array.isArray(res.data) ? res.data : [];
      yield data;
      bookmark = res.bookmark;
      if (!bookmark || bookmark === '-end-' || !data.length) return;
      await sleep(150);
    }
  }

  const BOARD_HANDLER = 'www/[username]/[slug].js';
  const pinCache = new Map();
  const boardCache = new Map();

  async function fetchPin(id) {
    if (pinCache.has(id)) return pinCache.get(id);
    const res = await pws('Pin', { id, field_set_key: 'detailed' }, `/pin/${id}/`, 'www/pin/[id].js');
    if (!res.data || !res.data.id) throw new Error('This pin isn’t available.');
    pinCache.set(id, res.data);
    return res.data;
  }

  async function fetchBoardInfo(user, slug) {
    const key = `${user}/${slug}`.toLowerCase();
    if (boardCache.has(key)) return boardCache.get(key);
    const src = `/${user}/${slug}/`;
    const res = await pws('Board', { username: user, slug, field_set_key: 'detailed' }, src, BOARD_HANDLER);
    const b = res.data;
    if (!b || !b.id) throw new Error('Not a board');
    const info = {
      id: b.id, name: b.name || slug, url: b.url || src,
      pinCount: b.pin_count || 0, sectionCount: b.section_count || 0,
    };
    boardCache.set(key, info);
    return info;
  }

  async function loadBoardPins(info, { onSections, onPins, stopped }) {
    const src = info.url;
    const sections = [];
    if (info.sectionCount) {
      for await (const data of pages('BoardSections', { board_id: info.id }, src, BOARD_HANDLER)) {
        for (const s of data) {
          if (s && s.id) sections.push({ id: s.id, slug: s.slug, title: s.title || 'Untitled section' });
        }
      }
    }
    onSections(sections);
    // The board feed includes pins from sections too. Sections and the feed load side by side;
    // a pin that turns up in a section gets that section, whichever arrives first.
    const feedOptions = { board_id: info.id, board_url: src, page_size: 100, filter_section_pins: false };
    async function readFeed() {
      for await (const data of pages('BoardFeed', feedOptions, src, BOARD_HANDLER)) {
        if (stopped()) return;
        onPins(data, null);
      }
    }
    let nextSection = 0;
    async function readSections() {
      while (nextSection < sections.length && !stopped()) {
        const s = sections[nextSection++];
        for await (const data of pages('BoardSectionPins', { section_id: s.id }, `${src}${s.slug}/`, BOARD_HANDLER)) {
          if (stopped()) return;
          onPins(data, s.id);
        }
      }
    }
    await Promise.all([readFeed(), readSections(), readSections(), readSections()]);
  }

  /* ================= routes ================= */

  const RESERVED_TOP = new Set([
    'pin', 'search', 'ideas', 'today', 'settings', 'business', 'homefeed', 'news_hub', 'notifications',
    'inbox', 'login', 'signup', 'logout', 'about', 'password', 'explore', 'topics', 'categories', 'discover',
    'shopping', 'videos', 'following', 'me', 'edit', 'analytics', 'pin-builder', 'idea-pin-builder',
    'story-pin-builder', 'resource', 'oauth', 'help', 'convert', 'tv', 'collage-creator', 'shop', 'orders',
  ]);
  const RESERVED_BOARD = new Set(['pins', 'boards', 'followers', 'following', 'tried', 'more_ideas', 'collages']);

  function readRoute() {
    const id = M.pinIdFromUrl(location.pathname);
    if (id && location.pathname.startsWith('/pin/')) return { kind: 'pin', id };
    let seg;
    try { seg = location.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch (_) { return { kind: 'other' }; }
    if (seg.length >= 2 && seg.length <= 3) {
      const [user, slug, section] = seg;
      if (!RESERVED_TOP.has(user.toLowerCase()) && !user.startsWith('_') && !slug.startsWith('_') && !RESERVED_BOARD.has(slug.toLowerCase())) {
        const sec = section && !section.startsWith('_') && !['more_ideas', 'organize'].includes(section) ? section : null;
        return { kind: 'board', user, slug, section: sec };
      }
    }
    return { kind: 'other' };
  }

  const current = { route: { kind: 'other' }, board: null, boardPromise: null };
  let routeToken = 0;

  function onRoute() {
    const r = readRoute();
    const token = ++routeToken;
    current.route = r;
    current.board = null;
    current.boardPromise = null;
    hideLauncher();
    if (r.kind === 'pin') {
      showLauncher('Download pin');
    } else if (r.kind === 'board') {
      current.boardPromise = fetchBoardInfo(r.user, r.slug)
        .then((b) => {
          if (token !== routeToken) return null;
          current.board = b;
          if (r.section) showLauncher('Download section', b.name);
          else showLauncher('Download board', plural(b.pinCount, 'pin'));
          return b;
        })
        .catch(() => null);
    }
  }

  /* ================= UI shell ================= */

  const host = document.createElement('div');
  host.id = 'pin-sheet-host';
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
  const shadow = host.attachShadow({ mode: 'open' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS_TEXT());
    shadow.adoptedStyleSheets = [sheet];
  } catch (_) {
    shadow.append(h('style', { text: CSS_TEXT() }));
  }
  const layer = h('div', { class: 'layer' });
  shadow.append(layer);
  (document.documentElement || document.body).append(host);

  // Keep Pinterest's own keyboard shortcuts away from our controls.
  for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, (e) => e.stopPropagation());

  // While the picker is open it owns Esc and Cmd/Ctrl+A, wherever focus happens to be.
  window.addEventListener('keydown', (e) => {
    if (!picker) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      closePicker(picker);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      e.stopImmediatePropagation();
      selectVisible(picker, true);
    }
  }, true);

  /* ----- launcher ----- */
  const launcherMain = h('span', { class: 'l-main' });
  const launcherSub = h('span', { class: 'l-sub' });
  const launcher = h('button', { class: 'launcher', type: 'button', hidden: true }, icon('down', 18), launcherMain, launcherSub);
  launcher.addEventListener('click', () => {
    if (current.route.kind === 'pin') downloadPin(current.route.id);
    else openPicker();
  });
  layer.append(launcher);

  function showLauncher(main, sub) {
    launcherMain.textContent = main;
    launcherSub.textContent = sub || '';
    launcherSub.hidden = !sub;
    launcher.hidden = false;
  }
  function hideLauncher() { launcher.hidden = true; }

  /* ----- toast ----- */
  const toast = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite', hidden: true });
  layer.append(toast);
  let toastTimer = null;
  function showToast(text, { tone = 'info', actionLabel, onAction, stay = false } = {}) {
    const lead = tone === 'error' ? icon('alert', 16) : tone === 'done' ? icon('check', 16) : tone === 'busy' ? h('span', { class: 'spin' }) : null;
    toast.replaceChildren(
      ...[lead, h('span', { class: 't-text', text }),
        actionLabel ? h('button', { class: 't-act', type: 'button', onclick: () => { hideToast(); onAction(); } }, actionLabel) : null].filter(Boolean),
    );
    toast.dataset.tone = tone;
    toast.hidden = false;
    clearTimeout(toastTimer);
    if (!stay) toastTimer = setTimeout(hideToast, actionLabel ? 7000 : 3500);
  }
  function hideToast() { toast.hidden = true; }

  /* ----- hover button on pins ----- */
  const hoverBtn = h('button', { class: 'hover-dl', type: 'button', hidden: true, 'aria-label': 'Download pin', title: 'Download pin' });
  layer.append(hoverBtn);
  const pinStates = new Map();
  let hoverId = null;
  let hoverHideTimer = null;

  function paintHover() {
    const state = pinStates.get(hoverId) || 'idle';
    hoverBtn.dataset.state = state;
    hoverBtn.replaceChildren(state === 'busy' ? h('span', { class: 'spin' }) : state === 'done' ? icon('check', 18) : state === 'error' ? icon('alert', 18) : icon('down', 18));
  }
  function setPinState(id, state) {
    pinStates.set(id, state);
    if (id === hoverId) paintHover();
  }
  function hideHover() {
    clearTimeout(hoverHideTimer);
    hoverBtn.hidden = true;
    hoverId = null;
  }
  function scheduleHoverHide() {
    clearTimeout(hoverHideTimer);
    hoverHideTimer = setTimeout(hideHover, 180);
  }

  document.addEventListener('mouseover', (e) => {
    if (!settings.hoverButton || picker) return;
    if (e.target === host) { clearTimeout(hoverHideTimer); return; }
    const t = e.target;
    if (!(t instanceof Element)) return;
    const card = t.closest('[data-grid-item], [data-test-id="pinWrapper"]');
    const link = t.closest('a[href*="/pin/"]') || (card && card.querySelector('a[href*="/pin/"]'));
    const id = link && M.pinIdFromUrl(link.getAttribute('href') || '');
    if (!id) { scheduleHoverHide(); return; }
    const box = (card || link).getBoundingClientRect();
    if (box.width < 90 || box.height < 90) { scheduleHoverHide(); return; }
    clearTimeout(hoverHideTimer);
    hoverId = id;
    const size = 36;
    const left = Math.max(4, Math.min(window.innerWidth - size - 4, box.left + 10));
    const top = Math.max(4, Math.min(window.innerHeight - size - 4, box.top + box.height / 2 - size / 2));
    hoverBtn.style.left = `${left}px`;
    hoverBtn.style.top = `${top}px`;
    paintHover();
    hoverBtn.hidden = false;
  }, true);
  window.addEventListener('scroll', () => { if (!hoverBtn.hidden) hideHover(); }, { passive: true, capture: true });
  hoverBtn.addEventListener('mouseleave', scheduleHoverHide);
  hoverBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (hoverId) downloadPin(hoverId);
  });

  /* ================= downloads (talks to the service worker) ================= */

  let port = null;
  const jobs = new Map();
  let pingTimer = null;

  function connect() {
    if (port) return port;
    if (!extensionAlive()) throw new Error('Pin Sheet was updated. Reload this page to keep downloading.');
    port = chrome.runtime.connect({ name: 'pinsheet' });
    port.onMessage.addListener((m) => {
      const job = jobs.get(m.jobId);
      if (!job) return;
      if (m.type === 'progress' && job.onProgress) job.onProgress(m);
      if (m.type === 'done') {
        jobs.delete(m.jobId);
        job.onDone(m);
        if (!jobs.size) { clearInterval(pingTimer); pingTimer = null; }
      }
      job.last = m;
    });
    port.onDisconnect.addListener(() => {
      port = null;
      clearInterval(pingTimer);
      pingTimer = null;
      for (const [id, job] of jobs) {
        const last = job.last || { done: 0, failed: 0 };
        job.onDone({
          jobId: id, done: last.done || 0, failed: job.total - (last.done || 0), total: job.total,
          errors: [{ label: 'Downloads', reason: 'The downloader stopped. Try again.' }],
        });
      }
      jobs.clear();
    });
    return port;
  }

  function runJob(items, handlers) {
    const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    jobs.set(jobId, { ...handlers, total: items.length });
    try {
      connect().postMessage({ type: 'start', jobId, items });
    } catch (e) {
      jobs.delete(jobId);
      throw new Error(e && /updated/.test(e.message) ? e.message : 'Pin Sheet was updated. Reload this page to keep downloading.');
    }
    if (!pingTimer) {
      pingTimer = setInterval(() => { try { if (port) port.postMessage({ type: 'ping' }); } catch (_) {} }, 20000);
    }
    return jobId;
  }
  function cancelJob(jobId) { try { if (port) port.postMessage({ type: 'cancel', jobId }); } catch (_) {} }
  function showInFolder(downloadId) { try { connect().postMessage({ type: 'show', downloadId }); } catch (_) {} }

  function itemsForPin(pin, dir) {
    const files = M.pinFiles(pin);
    const base = M.fileBase(pin, settings.naming);
    const label = M.titleOf(pin) || `Pin ${pin.id}`;
    return files.map((f, i) => {
      const suffix = files.length > 1 ? `_${i + 1}` : '';
      return {
        path: `${dir}/${base}${suffix}`, safePath: `${dir}/${pin.id}${suffix}`,
        urls: f.urls, hls: f.hls || [], verify: !!f.verify, label: files.length > 1 ? `${label} (${i + 1})` : label,
      };
    });
  }

  // entries: [{ pin, dir }] -> download items, fetching full pin data only where the feed was incomplete.
  async function prepare(entries, onStep, stopped) {
    const out = new Array(entries.length);
    const missing = [];
    let next = 0;
    let count = 0;
    async function worker() {
      while (next < entries.length && !stopped()) {
        const i = next++;
        let pin = entries[i].pin;
        if (M.needsDetail(pin)) {
          try { pin = await fetchPin(pin.id); } catch (_) { /* use what we have */ }
        }
        const items = itemsForPin(pin, entries[i].dir);
        if (!items.length) missing.push({ label: M.titleOf(pin) || `Pin ${pin.id}`, reason: 'No image or video found' });
        out[i] = items;
        onStep(++count);
      }
    }
    await Promise.all([0, 1, 2, 3].map(worker));
    return { items: out.filter(Boolean).flat(), missing };
  }

  function singlesDir() {
    return current.board ? dirPath(current.board.name) : dirPath('Single pins');
  }

  async function downloadPin(id) {
    if (!id) return;
    if (pinStates.get(id) === 'busy') return;
    setPinState(id, 'busy');
    showToast('Getting pin…', { tone: 'busy', stay: true });
    try {
      const pin = await fetchPin(id);
      const items = itemsForPin(pin, singlesDir());
      if (!items.length) throw new Error('No image or video found in this pin.');
      const name = M.titleOf(pin) || 'pin';
      showToast(items.length > 1 ? `Saving ${items.length} files…` : 'Saving…', { tone: 'busy', stay: true });
      runJob(items, {
        onDone: (m) => {
          setPinState(id, m.failed && !m.done ? 'error' : 'done');
          if (m.done) {
            const what = m.done > 1 ? plural(m.done, 'file') : `“${trimLabel(name)}”`;
            const extra = m.failed ? `, ${m.failed} failed` : '';
            showToast(`Saved ${what}${extra}`, { tone: 'done', actionLabel: m.lastDownloadId !== null && m.lastDownloadId !== undefined ? 'Show in folder' : null, onAction: () => showInFolder(m.lastDownloadId) });
          } else {
            showToast(`Couldn’t save this pin. ${(m.errors && m.errors[0] && m.errors[0].reason) || ''}`.trim(), { tone: 'error' });
          }
        },
      });
    } catch (e) {
      setPinState(id, 'error');
      showToast(e.message || 'Couldn’t save this pin.', { tone: 'error' });
    }
  }

  function downloadImage(src) {
    const f = M.imageFromUrl(src);
    const stem = (String(src).split(/[?#]/)[0].split('/').pop() || 'image').replace(/\.[a-z0-9]+$/i, '');
    const dir = singlesDir();
    const item = { path: `${dir}/${M.cleanPart(stem) || 'image'}`, safePath: `${dir}/image`, urls: f.urls, hls: [], verify: true, label: 'Image' };
    showToast('Saving image…', { tone: 'busy', stay: true });
    try {
      runJob([item], {
        onDone: (m) => {
          if (m.done) showToast('Saved image', { tone: 'done', actionLabel: 'Show in folder', onAction: () => showInFolder(m.lastDownloadId) });
          else showToast('Couldn’t save this image.', { tone: 'error' });
        },
      });
    } catch (e) {
      showToast(e.message, { tone: 'error' });
    }
  }

  function trimLabel(s) {
    s = String(s || '').trim();
    return s.length > 40 ? s.slice(0, 38).trim() + '…' : s;
  }

  /* ================= board picker ================= */

  let picker = null;
  let savedOverflow = '';

  function lockScroll(on) {
    const el = document.documentElement;
    if (on) { savedOverflow = el.style.overflow; el.style.overflow = 'hidden'; }
    else el.style.overflow = savedOverflow;
  }

  async function openPicker() {
    if (picker || current.route.kind !== 'board') return;
    hideHover();
    hideToast();
    const r = current.route;
    const s = {
      route: r, info: null, pins: [], byId: new Map(), sections: [], cards: new Map(),
      selected: new Set(), filter: { section: 'all', type: 'all' }, visible: [], anchor: null, seq: 0,
      loading: true, error: null, closed: false, busy: false, cancelled: false, jobId: null, result: null,
    };
    picker = s;
    buildPicker(s);
    lockScroll(true);
    s.els.close.focus();
    try {
      s.info = current.board || (await fetchBoardInfo(r.user, r.slug));
      if (s.closed) return;
      renderHead(s);
      await loadBoardPins(s.info, {
        onSections: (list) => {
          s.sections = list;
          if (r.section) {
            const match = list.find((x) => x.slug === r.section);
            if (match) s.filter.section = match.id;
          }
          renderChips(s);
        },
        onPins: (data, sectionId) => addPins(s, data, sectionId),
        stopped: () => s.closed,
      });
    } catch (e) {
      s.error = e && e.status === 403
        ? 'This board is private or you’re signed out. Sign in to Pinterest and try again.'
        : (e && e.message) || 'Couldn’t load this board.';
    }
    s.loading = false;
    if (s.closed) return;
    renderAll(s);
  }

  function buildPicker(s) {
    const els = (s.els = {});
    els.title = h('h2', { id: 'ps-title', text: 'Loading board…' });
    els.sub = h('p', { class: 'sub', text: '' });
    els.close = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => closePicker(s) }, icon('close', 20));
    els.chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Sections', hidden: true });
    els.typeBtns = ['all', 'images', 'motion'].map((t) =>
      h('button', {
        type: 'button', 'aria-pressed': t === 'all' ? 'true' : 'false',
        onclick: () => { s.filter.type = t; renderAll(s); },
      }, t === 'all' ? 'All types' : t === 'images' ? 'Images' : 'Motion'));
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Type' }, els.typeBtns);
    const selTools = h('div', { class: 'sel-tools' },
      h('button', { class: 'link', type: 'button', onclick: () => selectVisible(s, true) }, 'Select all'),
      h('button', { class: 'link', type: 'button', onclick: () => clearSelection(s) }, 'Clear'),
      h('button', { class: 'link', type: 'button', onclick: () => invertVisible(s) }, 'Invert'),
      h('span', { class: 'hint' }, 'Shift-click to select a range'));
    els.loadbar = h('div', { class: 'loadbar', 'aria-hidden': 'true' });
    els.grid = h('div', { class: 'grid', role: 'group', 'aria-label': 'Pins' });
    els.empty = h('div', { class: 'empty', hidden: true });
    els.gridWrap = h('div', { class: 'grid-wrap' }, els.loadbar, els.grid, els.empty);

    els.count = h('p', { class: 'count' });
    els.bar = h('i');
    els.progText = h('span', { class: 'prog-text' });
    els.progress = h('div', { class: 'progress', hidden: true }, els.progText, h('div', { class: 'bar' }, els.bar));
    els.errors = h('ul', { class: 'errors', hidden: true });
    els.cancel = h('button', { class: 'ghost', type: 'button', hidden: true, onclick: () => cancelPicker(s) }, 'Cancel');
    els.show = h('button', { class: 'ghost', type: 'button', hidden: true }, 'Show in folder');
    els.dl = h('button', { class: 'primary', type: 'button', onclick: () => onPrimary(s) }, icon('down', 18), h('span'));
    const foot = h('footer', { class: 'foot' }, els.count, els.progress, h('div', { class: 'actions' }, els.cancel, els.show, els.dl));

    els.sheet = h('section', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ps-title' },
      h('header', { class: 'head' }, h('div', { class: 'titles' }, els.title, els.sub), els.close),
      h('div', { class: 'tools' }, els.chips, h('div', { class: 'row2' }, seg, selTools)),
      els.gridWrap, els.errors, foot);
    els.scrim = h('div', { class: 'scrim' }, els.sheet);
    els.scrim.addEventListener('mousedown', (e) => { if (e.target === els.scrim) closePicker(s); });
    layer.append(els.scrim);
    renderAll(s);
  }

  function closePicker(s) {
    if (s.closed) return;
    s.closed = true;
    if (picker === s) picker = null;
    s.els.scrim.remove();
    lockScroll(false);
    if (!launcher.hidden) launcher.focus();
    if (s.busy) showToast('Still saving in the background…', { tone: 'busy', stay: true });
  }

  function addPins(s, data, sectionId) {
    let changed = false;
    for (const raw of data) {
      if (!raw || !raw.id || (raw.type && raw.type !== 'pin')) continue;
      const known = s.byId.get(raw.id);
      if (known) {
        if (sectionId && !known.section) { known.section = sectionId; changed = true; }
        continue;
      }
      const p = { id: raw.id, raw, section: sectionId, seq: s.seq++, no: 0, ...M.describe(raw) };
      s.pins.push(p);
      s.byId.set(p.id, p);
      changed = true;
    }
    if (changed && !s.closed) renderAll(s);
  }

  // Board order: sections in Pinterest's order, then pins with no section. Frame numbers follow it.
  function orderPins(s) {
    const rankOf = new Map(s.sections.map((x, i) => [x.id, i]));
    const rank = (p) => (p.section && rankOf.has(p.section) ? rankOf.get(p.section) : s.sections.length);
    s.pins.sort((a, b) => rank(a) - rank(b) || a.seq - b.seq);
    s.pins.forEach((p, i) => {
      if (p.no === i + 1) return;
      p.no = i + 1;
      const card = s.cards.get(p.id);
      if (card) card.querySelector('.no').textContent = String(p.no).padStart(3, '0');
    });
  }

  function sectionTitle(s, id) {
    const sec = s.sections.find((x) => x.id === id);
    return sec ? sec.title : '';
  }

  function computeVisible(s) {
    const { section, type } = s.filter;
    s.visible = s.pins.filter((p) =>
      (section === 'all' || (section === 'none' ? !p.section : p.section === section)) &&
      (type === 'all' || (type === 'motion' ? !!p.motion : !p.motion)));
  }

  function renderAll(s) {
    orderPins(s);
    computeVisible(s);
    renderHead(s);
    renderChips(s);
    s.els.typeBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(['all', 'images', 'motion'][i] === s.filter.type)));
    renderGrid(s);
    renderFoot(s);
  }

  function renderHead(s) {
    const { els } = s;
    if (s.info) els.title.textContent = s.info.name;
    if (s.error) { els.sub.textContent = ''; return; }
    const n = s.pins.length;
    if (s.loading) els.sub.textContent = n ? `Loading pins… ${n.toLocaleString()} so far` : 'Loading pins…';
    else if (s.sections.length) els.sub.textContent = `${plural(n, 'pin')} in ${plural(s.sections.length, 'section')}`;
    else els.sub.textContent = plural(n, 'pin');
    els.loadbar.hidden = !s.loading;
  }

  function chip(s, key, label, count) {
    return h('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(s.filter.section === key),
      onclick: () => { s.filter.section = key; s.anchor = null; renderAll(s); },
    }, h('span', { text: label }), h('span', { class: 'n', text: count.toLocaleString() }));
  }

  function renderChips(s) {
    const { els } = s;
    if (!s.sections.length) { els.chips.hidden = true; return; }
    const counts = new Map();
    let none = 0;
    for (const p of s.pins) {
      if (p.section) counts.set(p.section, (counts.get(p.section) || 0) + 1);
      else none++;
    }
    const list = [chip(s, 'all', 'All pins', s.pins.length)];
    for (const sec of s.sections) list.push(chip(s, sec.id, sec.title, counts.get(sec.id) || 0));
    if (none) list.push(chip(s, 'none', 'No section', none));
    els.chips.replaceChildren(...list);
    els.chips.hidden = false;
  }

  function cardFor(s, p) {
    let card = s.cards.get(p.id);
    if (card) return card;
    const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    if (p.thumb) img.src = p.thumb;
    const kind = h('span', { class: p.motion ? 'kind motion' : 'kind' }, p.motion === 'video' ? icon('play', 10) : null, p.label);
    card = h('button', {
      class: 'frame', type: 'button', 'aria-pressed': 'false', title: p.title || 'Untitled pin',
      'aria-label': `${p.title || 'Untitled pin'}, ${p.label}`,
    },
      h('span', { class: 'pic' }, img),
      h('span', { class: 'edge' }, h('span', { class: 'no', text: String(p.no).padStart(3, '0') }), kind),
      h('span', { class: 'tick', 'aria-hidden': 'true' }, icon('check', 14)));
    card.addEventListener('click', (e) => onCardClick(s, p, e));
    card.addEventListener('mousedown', (e) => { if (e.shiftKey) e.preventDefault(); });
    s.cards.set(p.id, card);
    return card;
  }

  function paintCard(s, p) {
    const card = s.cards.get(p.id);
    if (card) card.setAttribute('aria-pressed', String(s.selected.has(p.id)));
  }

  function renderGrid(s) {
    const { els } = s;
    const cards = s.visible.map((p) => { const c = cardFor(s, p); c.setAttribute('aria-pressed', String(s.selected.has(p.id))); return c; });
    els.grid.replaceChildren(...cards);
    let empty = '';
    if (s.error) empty = s.error;
    else if (!s.loading && !s.pins.length) empty = 'This board has no pins yet.';
    else if (!s.loading && !s.visible.length) {
      empty = s.filter.type === 'motion' ? 'No videos or GIFs here.' : s.filter.type === 'images' ? 'No still images here.' : 'No pins here.';
    }
    els.empty.replaceChildren(h('p', { text: empty }), s.error ? h('button', { class: 'ghost', type: 'button', onclick: () => { closePicker(s); openPicker(); } }, 'Try again') : null);
    els.empty.hidden = !empty;
  }

  function onCardClick(s, p, e) {
    if (s.busy) return;
    const idx = s.visible.indexOf(p);
    const from = s.anchor ? s.visible.findIndex((x) => x.id === s.anchor) : -1;
    const turnOn = !s.selected.has(p.id);
    if (e.shiftKey && from >= 0 && idx >= 0) {
      const a = Math.min(from, idx);
      const b = Math.max(from, idx);
      for (let i = a; i <= b; i++) setSelected(s, s.visible[i], turnOn);
    } else {
      setSelected(s, p, turnOn);
    }
    s.anchor = p.id;
    renderFoot(s);
  }

  function setSelected(s, p, on) {
    if (on) s.selected.add(p.id);
    else s.selected.delete(p.id);
    paintCard(s, p);
  }
  function selectVisible(s, on) {
    if (s.busy) return;
    for (const p of s.visible) setSelected(s, p, on);
    renderFoot(s);
  }
  function invertVisible(s) {
    if (s.busy) return;
    for (const p of s.visible) setSelected(s, p, !s.selected.has(p.id));
    renderFoot(s);
  }
  function clearSelection(s) {
    if (s.busy) return;
    for (const id of [...s.selected]) { s.selected.delete(id); const p = s.byId.get(id); if (p) paintCard(s, p); }
    s.anchor = null;
    renderFoot(s);
  }

  function scopeName(s) {
    const { section, type } = s.filter;
    const where = section === 'all' ? '' : section === 'none' ? ' with no section' : ` in ${sectionTitle(s, section)}`;
    const what = type === 'motion' ? ' motion' : type === 'images' ? ' image' : '';
    return { where, what };
  }

  function setPrimary(s, label, disabled, withIcon = true) {
    s.els.dl.querySelector('span').textContent = label;
    s.els.dl.querySelector('svg').style.display = withIcon ? '' : 'none';
    s.els.dl.disabled = !!disabled;
  }

  function renderFoot(s) {
    const { els } = s;
    if (s.busy || s.result) return;
    els.progress.hidden = true;
    els.count.hidden = false;
    els.cancel.hidden = true;
    els.show.hidden = true;
    els.dl.hidden = false;
    const n = s.selected.size;
    if (n) {
      let images = 0;
      let motion = 0;
      for (const id of s.selected) { const p = s.byId.get(id); if (p && p.motion) motion++; else images++; }
      const parts = [];
      if (images) parts.push(plural(images, 'image'));
      if (motion) parts.push(`${motion.toLocaleString()} motion`);
      els.count.replaceChildren(h('strong', { text: `${plural(n, 'pin')} selected` }), h('span', { class: 'muted', text: `  ${parts.join(', ')}` }));
      setPrimary(s, `Download ${plural(n, 'pin')}`, false);
    } else {
      const v = s.visible.length;
      const { where, what } = scopeName(s);
      els.count.replaceChildren(h('span', { class: 'muted', text: s.loading ? 'Pick pins as they load, or wait for the full board.' : 'Click pins to pick them, or download everything shown.' }));
      setPrimary(s, s.loading ? 'Download all' : `Download all ${v.toLocaleString()}${what}${where}`, s.loading || !v || !!s.error);
    }
  }

  function showProgress(s, text, fraction) {
    const { els } = s;
    els.count.hidden = true;
    els.progress.hidden = false;
    els.progText.textContent = text;
    els.bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    els.cancel.hidden = false;
    els.show.hidden = true;
    els.dl.hidden = true;
  }

  function onPrimary(s) {
    if (s.result) { s.result = null; s.els.errors.hidden = true; renderFoot(s); return; }
    startPickerDownload(s);
  }

  async function startPickerDownload(s) {
    if (s.busy) return;
    const chosen = s.selected.size ? s.pins.filter((p) => s.selected.has(p.id)) : s.visible.slice();
    if (!chosen.length) return;
    s.busy = true;
    s.cancelled = false;
    s.result = null;
    s.els.sheet.classList.add('busy');
    s.els.errors.hidden = true;
    const boardName = s.info.name;
    const entries = chosen.map((p) => ({
      pin: p.raw,
      dir: dirPath(boardName, settings.sectionFolders && p.section ? sectionTitle(s, p.section) : ''),
    }));
    showProgress(s, `Preparing ${plural(chosen.length, 'pin')}…`, 0);
    const { items, missing } = await prepare(entries,
      (n) => { if (!s.closed) showProgress(s, `Preparing ${n.toLocaleString()} of ${chosen.length.toLocaleString()} pins…`, 0.04 * (n / chosen.length)); },
      () => s.cancelled);
    if (s.cancelled) return finishPicker(s, { done: 0, failed: 0, errors: [], cancelled: true });
    if (!items.length) return finishPicker(s, { done: 0, failed: missing.length, errors: missing });
    try {
      s.jobId = runJob(items, {
        onProgress: (m) => {
          const text = `Saving ${(m.done + m.failed).toLocaleString()} of ${plural(m.total, 'file')}…`;
          if (s.closed) showToast(text, { tone: 'busy', stay: true });
          else showProgress(s, text, 0.04 + 0.96 * ((m.done + m.failed) / m.total));
        },
        onDone: (m) => finishPicker(s, { ...m, failed: (m.failed || 0) + missing.length, errors: missing.concat(m.errors || []) }),
      });
    } catch (e) {
      finishPicker(s, { done: 0, failed: items.length, errors: [{ label: 'Downloads', reason: e.message }] });
    }
  }

  function cancelPicker(s) {
    s.cancelled = true;
    if (s.jobId) cancelJob(s.jobId);
    showProgress(s, 'Stopping…', parseFloat(s.els.bar.style.width || '0') / 100);
    s.els.cancel.hidden = true;
  }

  function finishPicker(s, res) {
    s.busy = false;
    s.jobId = null;
    const folder = `Downloads/${dirPath(s.info ? s.info.name : '')}`;
    const canShow = res.lastDownloadId !== null && res.lastDownloadId !== undefined && res.done > 0;
    let text;
    if (res.cancelled) text = res.done ? `Stopped. ${plural(res.done, 'file')} saved.` : 'Download stopped.';
    else if (res.done && !res.failed) text = `Saved ${plural(res.done, 'file')} to ${folder}`;
    else if (res.done) text = `Saved ${plural(res.done, 'file')}. ${res.failed.toLocaleString()} couldn’t be saved.`;
    else text = 'Nothing was saved.';

    if (s.closed) {
      showToast(text, {
        tone: res.done ? 'done' : 'error',
        actionLabel: canShow ? 'Show in folder' : null,
        onAction: () => showInFolder(res.lastDownloadId),
      });
      return;
    }
    const { els } = s;
    s.result = res;
    els.sheet.classList.remove('busy');
    els.progress.hidden = true;
    els.count.hidden = false;
    els.count.replaceChildren(h('strong', { text }));
    els.cancel.hidden = true;
    els.show.hidden = !canShow;
    els.show.onclick = () => showInFolder(res.lastDownloadId);
    els.dl.hidden = false;
    setPrimary(s, 'Done', false, false);
    const errs = res.errors || [];
    els.errors.replaceChildren(...errs.slice(0, 100).map((e) => h('li', {}, h('strong', { text: trimLabel(e.label) }), ` ${e.reason}`)));
    els.errors.hidden = !errs.length;
  }

  /* ================= popup + menu messages ================= */

  try {
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'context') {
        const r = current.route;
        const answer = () => ({
          kind: r.kind, ready: r.kind === 'pin' || !!current.board,
          name: current.board ? current.board.name : null,
          pinCount: current.board ? current.board.pinCount : 0,
          section: r.kind === 'board' ? r.section : null,
        });
        if (r.kind === 'board' && !current.board && current.boardPromise) {
          Promise.race([current.boardPromise, sleep(4000)]).then(() => reply(answer()));
          return true;
        }
        reply(answer());
      } else if (msg.type === 'open-picker') {
        openPicker();
        reply({ ok: true });
      } else if (msg.type === 'download-pin') {
        downloadPin(msg.id || (current.route.kind === 'pin' ? current.route.id : null));
        reply({ ok: true });
      } else if (msg.type === 'download-image') {
        downloadImage(msg.src);
        reply({ ok: true });
      }
      return undefined;
    });
  } catch (_) { /* extension reloaded */ }

  /* ================= start ================= */

  let lastHref = '';
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      onRoute();
    }
  }, 400);

  /* ================= styles ================= */

  function CSS_TEXT() {
    return `
:host { all: initial; }
.layer {
  --table: #E7EBEE; --sheet: #FFFFFF; --ink: #1E2226; --ink-2: #5B656F; --rule: #CDD4DA;
  --well: #DCE2E6; --marker: #F2551D; --frame: #D5DCE1; --bad: #B42318;
  --ui: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --edge: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font: 14px/1.4 var(--ui); color: var(--ink); -webkit-font-smoothing: antialiased;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
button { font: inherit; color: inherit; }
button:focus-visible { outline: 2px solid var(--marker); outline-offset: 2px; }

.launcher {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); pointer-events: auto;
  display: inline-flex; align-items: center; gap: 10px; height: 44px; padding: 0 18px 0 14px;
  border: 0; border-radius: 22px; background: var(--ink); color: #fff; cursor: pointer;
  font: 600 14px/1 var(--ui); box-shadow: 0 8px 24px rgba(20, 24, 28, .28);
}
.launcher:hover { background: #31373D; }
.launcher svg { color: var(--marker); }
.launcher .l-sub { font-weight: 400; color: #AEB7BF; }

.hover-dl {
  position: fixed; width: 36px; height: 36px; pointer-events: auto; cursor: pointer;
  display: grid; place-items: center; border: 0; border-radius: 10px;
  background: rgba(255, 255, 255, .95); color: var(--ink); box-shadow: 0 2px 10px rgba(0, 0, 0, .22);
}
.hover-dl:hover { background: #fff; color: var(--marker); }
.hover-dl[data-state="done"] { background: var(--marker); color: #fff; }
.hover-dl[data-state="error"] { color: var(--bad); }

.toast {
  position: fixed; left: 50%; bottom: 80px; transform: translateX(-50%); pointer-events: auto;
  display: flex; align-items: center; gap: 10px; max-width: min(560px, calc(100vw - 32px));
  padding: 11px 14px; border-radius: 12px; background: var(--ink); color: #fff;
  font: 500 14px/1.35 var(--ui); box-shadow: 0 8px 24px rgba(20, 24, 28, .3);
}
.toast svg { flex: none; color: var(--marker); }
.toast[data-tone="error"] svg { color: #FF8A7A; }
.t-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t-act { flex: none; border: 0; background: none; padding: 4px 2px; color: #FFB08F; font-weight: 600; cursor: pointer; }
.t-act:hover { text-decoration: underline; }

.spin {
  width: 16px; height: 16px; flex: none; border-radius: 50%;
  border: 2px solid rgba(127, 127, 127, .35); border-top-color: var(--marker); animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.scrim {
  position: fixed; inset: 0; pointer-events: auto; display: grid; place-items: center;
  padding: 24px; background: rgba(22, 26, 30, .45);
}
.sheet {
  position: relative; width: min(1320px, 100%); height: min(920px, 100%);
  display: grid; grid-template-rows: auto auto 1fr auto auto; overflow: hidden;
  background: var(--table); border-radius: 16px; box-shadow: 0 30px 90px rgba(0, 0, 0, .35);
}
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 22px 24px 6px; }
.titles { min-width: 0; }
.head h2 { margin: 0; font: 700 22px/1.2 var(--ui); letter-spacing: -.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { margin: 4px 0 0; color: var(--ink-2); font-size: 13px; }
.icon-btn { flex: none; width: 36px; height: 36px; border: 0; border-radius: 18px; background: transparent; display: grid; place-items: center; cursor: pointer; color: var(--ink); }
.icon-btn:hover { background: var(--well); }

.tools { display: grid; gap: 12px; padding: 10px 24px 14px; border-bottom: 1px solid var(--rule); }
.chips { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding-bottom: 1px; }
.chips::-webkit-scrollbar { display: none; }
.chip {
  flex: none; display: inline-flex; align-items: center; gap: 7px; height: 32px; padding: 0 12px;
  border: 1px solid var(--rule); border-radius: 16px; background: var(--sheet); cursor: pointer;
  font: 500 13px/1 var(--ui);
}
.chip .n { font: 12px/1 var(--edge); color: var(--ink-2); }
.chip:hover { border-color: #AEB8C0; }
.chip[aria-pressed="true"] { background: var(--ink); border-color: var(--ink); color: #fff; }
.chip[aria-pressed="true"] .n { color: #AEB7BF; }
.row2 { display: flex; align-items: center; justify-content: space-between; gap: 12px 20px; flex-wrap: wrap; }
.seg { display: inline-flex; padding: 3px; border-radius: 10px; background: var(--well); }
.seg button { height: 28px; padding: 0 12px; border: 0; border-radius: 8px; background: transparent; color: var(--ink-2); font: 500 13px/1 var(--ui); cursor: pointer; }
.seg button[aria-pressed="true"] { background: var(--sheet); color: var(--ink); box-shadow: 0 1px 2px rgba(0, 0, 0, .14); }
.sel-tools { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
.link { height: 30px; padding: 0 9px; border: 0; border-radius: 7px; background: none; font: 500 13px/1 var(--ui); cursor: pointer; }
.link:hover { background: var(--well); }
.hint { margin-left: 8px; color: var(--ink-2); font-size: 12px; }

.grid-wrap { position: relative; overflow: auto; padding: 24px 24px 32px; overscroll-behavior: contain; }
.loadbar { position: absolute; top: 0; left: 0; right: 0; height: 3px; overflow: hidden; }
.loadbar::before {
  content: ""; position: absolute; top: 0; bottom: 0; width: 30%; background: var(--marker);
  animation: slide 1.1s ease-in-out infinite;
}
@keyframes slide { from { left: -30%; } to { left: 100%; } }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(138px, 1fr)); gap: 24px 18px; }
.frame {
  position: relative; display: flex; flex-direction: column; padding: 0; border: 0; border-radius: 6px;
  background: var(--sheet); text-align: left; cursor: pointer; user-select: none;
  box-shadow: 0 0 0 1px rgba(30, 34, 38, .06), 0 1px 2px rgba(30, 34, 38, .08);
}
.pic { display: block; aspect-ratio: 4 / 5; overflow: hidden; border-radius: 6px 6px 0 0; background: var(--frame); }
.pic img { display: block; width: 100%; height: 100%; object-fit: cover; }
.frame:hover .pic img { filter: brightness(.93); }
.edge { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 7px 8px 8px; color: var(--ink-2); }
.no { font: 11px/1 var(--edge); letter-spacing: .02em; }
.kind { display: inline-flex; align-items: center; gap: 4px; font: 500 11px/1 var(--ui); white-space: nowrap; }
.kind.motion { color: var(--ink); }
.frame::after {
  content: ""; position: absolute; inset: -6px; pointer-events: none; opacity: 0;
  border: 3px solid var(--marker); border-radius: 22px 10px 18px 8px / 9px 18px 10px 20px;
  transform: rotate(-.8deg) scale(.97); transition: opacity .12s ease, transform .12s ease;
}
.frame:nth-child(3n+1)::after { border-radius: 12px 20px 9px 18px / 18px 9px 20px 10px; transform: rotate(.7deg) scale(.97); }
.frame:nth-child(3n+2)::after { border-radius: 16px 12px 22px 10px / 12px 20px 8px 16px; transform: rotate(-.3deg) scale(.97); }
.frame[aria-pressed="true"]::after { opacity: 1; transform: rotate(-.8deg); }
.frame:nth-child(3n+1)[aria-pressed="true"]::after { transform: rotate(.7deg); }
.frame:nth-child(3n+2)[aria-pressed="true"]::after { transform: rotate(-.3deg); }
.frame[aria-pressed="true"] .no { color: var(--marker); font-weight: 700; }
.tick {
  position: absolute; top: 8px; left: 8px; width: 24px; height: 24px; display: grid; place-items: center;
  border-radius: 50%; background: var(--marker); color: #fff; opacity: 0; transform: scale(.6);
  transition: opacity .12s ease, transform .12s ease; box-shadow: 0 1px 4px rgba(0, 0, 0, .25);
}
.frame[aria-pressed="true"] .tick { opacity: 1; transform: none; }
.frame:focus-visible { outline: 2px solid var(--ink); outline-offset: 5px; }
.sheet.busy .grid { pointer-events: none; opacity: .5; }
.sheet.busy .tools { pointer-events: none; opacity: .6; }
.empty { display: grid; justify-items: center; gap: 14px; padding: 72px 24px; color: var(--ink-2); text-align: center; }
.empty p { margin: 0; font-size: 15px; }

.errors {
  margin: 0; padding: 10px 24px; max-height: 132px; overflow: auto; list-style: none;
  background: #FFF3EE; border-top: 1px solid #F5CDBD; color: #7A2A0E; font-size: 12px; line-height: 1.6;
}
.foot { display: flex; align-items: center; gap: 16px; padding: 14px 24px; background: var(--sheet); border-top: 1px solid var(--rule); }
.count { flex: 1; min-width: 0; margin: 0; font-size: 14px; }
.count strong { font-weight: 600; }
.muted { color: var(--ink-2); }
.progress { flex: 1; min-width: 0; display: grid; gap: 7px; }
.prog-text { font-size: 13px; color: var(--ink); }
.bar { height: 6px; border-radius: 3px; background: #E2E7EB; overflow: hidden; }
.bar i { display: block; width: 0; height: 100%; background: var(--marker); transition: width .2s ease; }
.actions { display: flex; align-items: center; gap: 8px; flex: none; }
.primary, .ghost {
  height: 40px; padding: 0 18px; border-radius: 20px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 8px; font: 600 14px/1 var(--ui); white-space: nowrap;
}
.primary { border: 0; background: var(--ink); color: #fff; }
.primary svg { color: var(--marker); }
.primary:hover { background: #31373D; }
.primary:disabled { background: #9AA3AB; cursor: default; }
.primary:disabled svg { color: #fff; }
.ghost { border: 1px solid var(--rule); background: var(--sheet); font-weight: 500; }
.ghost:hover { border-color: #AEB8C0; }

@media (max-width: 720px) {
  .scrim { padding: 0; }
  .sheet { border-radius: 0; height: 100%; }
  .hint { display: none; }
  .grid { grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 18px 12px; }
  .foot { flex-wrap: wrap; }
}
@media (prefers-reduced-motion: reduce) {
  .frame::after, .tick, .bar i { transition: none; }
  .loadbar::before, .spin { animation-duration: 3s; }
}
`;
  }
})();
