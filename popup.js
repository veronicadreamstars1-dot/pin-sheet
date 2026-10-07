'use strict';

const DEFAULTS = { root: 'Pinterest', naming: 'title', hoverButton: true };
const $ = (id) => document.getElementById(id);
const plural = (n, w) => `${Number(n || 0).toLocaleString()} ${n === 1 ? w : w + 's'}`;

function cleanRoot(value) {
  const parts = String(value || '')
    .split('/')
    .map((p) => p.replace(/[\u0000-\u001f<>:"\\|?*]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[.~]+|\.+$/g, ''))
    .filter(Boolean);
  return parts.join('/') || 'Pinterest';
}

function setCtx(title, sub, buttonLabel, onClick) {
  $('ctxTitle').textContent = title;
  $('ctxSub').textContent = sub || '';
  const btn = $('ctxBtn');
  btn.hidden = !buttonLabel;
  if (buttonLabel) {
    btn.textContent = buttonLabel;
    btn.onclick = onClick;
  }
}

function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function showRootHint(root) {
  $('rootHint').textContent = `Today’s pins go to Downloads/${root}/${todayStamp()}/`;
}

async function loadSettings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $('root').value = s.root;
  showRootHint(cleanRoot(s.root));
  $('naming').value = s.naming;
  $('hoverButton').checked = s.hoverButton;

  $('root').addEventListener('change', () => {
    const v = cleanRoot($('root').value);
    $('root').value = v;
    showRootHint(v);
    chrome.storage.sync.set({ root: v });
  });
  $('naming').addEventListener('change', () => chrome.storage.sync.set({ naming: $('naming').value }));
  $('hoverButton').addEventListener('change', () => chrome.storage.sync.set({ hoverButton: $('hoverButton').checked }));
  $('settings').addEventListener('submit', (e) => e.preventDefault());
}

async function loadContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onPinterest = tab && /^https?:\/\/([^/]+\.)?pinterest\.[a-z.]+\//i.test(tab.url || '');
  if (!onPinterest) {
    setCtx('Open Pinterest to start', 'Open a board to pick pins, or hover any pin to save it.');
    return;
  }
  const send = (msg) => chrome.tabs.sendMessage(tab.id, msg).then(() => window.close()).catch(() => {});
  let info;
  try {
    info = await chrome.tabs.sendMessage(tab.id, { type: 'context' });
  } catch (_) {
    setCtx('Reload this tab', 'Pin Sheet starts working on this page after a reload.', 'Reload tab', () => {
      chrome.tabs.reload(tab.id);
      window.close();
    });
    return;
  }
  if (info && info.kind === 'board' && info.ready) {
    const sub = info.section ? 'Opens on this section. You can switch to the full board.' : plural(info.pinCount, 'pin');
    setCtx(info.name, sub, 'Choose pins to download', () => send({ type: 'open-picker' }));
  } else if (info && info.kind === 'pin') {
    setCtx('This pin', 'Saves the image, GIF or video. Idea pins save every page.', 'Download this pin', () => send({ type: 'download-pin' }));
  } else {
    setCtx('Open a board or a pin', 'Hover any pin to save it, or open a board to pick pins in bulk.');
  }
}

loadSettings();
loadContext();
