// Окно расширения: трансляции канала. Список берём из того же внутреннего API, что использует сайт YouTube,
// поэтому ключ не нужен. Нажатие открывает стрим на YouTube сразу с панелью клипа.
'use strict';

const DEFAULT_CHANNEL = '@Vibe_Quuenn';
const STREAMS_TAB = 'EgdzdHJlYW1z8gYECgJ6AA%3D%3D'; // вкладка «Трансляции» канала
const CLIENT = { clientName: 'WEB', clientVersion: '2.20261028.01.00', hl: 'ru', gl: 'RU' };
const $ = id => document.getElementById(id);

function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
  return node;
}

// API YouTube отвечает 403 на заголовок Origin: chrome-extension://… (и moz-extension://… в Firefox) —
// для запросов окна расширения подставляем Origin самого YouTube. Домен окна — это id расширения в Chrome
// и внутренний UUID в Firefox.
let originRule = null;
function fixOrigin() {
  originRule ??= chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'set', value: 'https://www.youtube.com' }] },
      condition: { urlFilter: '|https://www.youtube.com/youtubei/', initiatorDomains: [location.hostname], resourceTypes: ['xmlhttprequest'] },
    }],
  });
  return originRule;
}

async function yt(endpoint, body) {
  await fixOrigin();
  const r = await fetch(`https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context: { client: CLIENT }, ...body }),
  });
  if (!r.ok) throw new Error(`YouTube ответил ошибкой ${r.status}.`);
  return r.json();
}

function normalizeChannel(input) {
  const s = input.trim();
  const url = /youtube\.com\/((?:@|channel\/)[\w.\-%]+)/i.exec(s);
  if (url) return url[1].startsWith('channel/') ? url[1].slice(8) : decodeURIComponent(url[1]);
  if (/^UC[\w-]{22}$/.test(s)) return s;
  return s ? (s.startsWith('@') ? s : '@' + s) : DEFAULT_CHANNEL;
}

async function resolveChannel(handle) {
  if (/^UC[\w-]{22}$/.test(handle)) return handle;
  const { ids = {} } = await chrome.storage.local.get('ids');
  if (ids[handle]) return ids[handle];
  const r = await yt('navigation/resolve_url', { url: 'https://www.youtube.com/' + handle });
  const id = r?.endpoint?.browseEndpoint?.browseId;
  if (!id) throw new Error(`Канал ${handle} не найден.`);
  ids[handle] = id;
  await chrome.storage.local.set({ ids });
  return id;
}

// Карточки видео YouTube отдаёт в двух форматах: новом (lockupViewModel) и старом (videoRenderer).
function collect(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (node.lockupViewModel?.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') out.push(fromLockup(node.lockupViewModel));
  else if (node.videoRenderer?.videoId) out.push(fromRenderer(node.videoRenderer));
  else for (const k in node) collect(node[k], out);
  return out;
}
function findBadge(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.thumbnailBadgeViewModel) return node.thumbnailBadgeViewModel;
  for (const k in node) { const b = findBadge(node[k]); if (b) return b; }
  return null;
}
function fromLockup(l) {
  const tvm = l.contentImage?.thumbnailViewModel;
  const sources = tvm?.image?.sources || [];
  const badge = findBadge(tvm?.overlays);
  const md = l.metadata?.lockupMetadataViewModel;
  const rows = md?.metadata?.contentMetadataViewModel?.metadataRows || [];
  return {
    id: l.contentId,
    title: md?.title?.content || '',
    thumb: (sources.find(s => s.width >= 300) || sources[0])?.url || `https://i.ytimg.com/vi/${l.contentId}/mqdefault.jpg`,
    badge: badge?.text || '',
    live: /LIVE/.test(badge?.badgeStyle || ''),
    meta: rows.map(r => (r.metadataParts || []).map(p => p.text?.content).filter(Boolean).join(' • ')).filter(Boolean).join(' • '),
  };
}
function fromRenderer(v) {
  const text = t => t?.simpleText || (t?.runs || []).map(r => r.text).join('');
  const live = (v.badges || []).some(b => /LIVE/.test(b.metadataBadgeRenderer?.style || '')) ||
    (v.thumbnailOverlays || []).some(o => o.thumbnailOverlayTimeStatusRenderer?.style === 'LIVE');
  return {
    id: v.videoId,
    title: text(v.title),
    thumb: v.thumbnail?.thumbnails?.at(-1)?.url || `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
    badge: live ? 'В ЭФИРЕ' : text(v.lengthText),
    live,
    meta: [text(v.viewCountText), text(v.publishedTimeText)].filter(Boolean).join(' • '),
  };
}

function skeleton() {
  $('list').replaceChildren(...Array.from({ length: 4 }, () =>
    el('div', { class: 'skel' }, el('div', { class: 'thumb' }), el('div', { class: 'lines' }, el('i'), el('i')))));
}
function message(...parts) { $('list').replaceChildren(el('div', { class: 'msg' }, ...parts)); }

function render(items) {
  if (!items.length) {
    return message(el('b', { text: 'Сейчас на канале нет открытых трансляций.' }),
      el('br'), 'Когда стрим начнётся, он появится здесь. Клип можно сделать и из любого другого видео — кнопкой ✂ в плеере YouTube.');
  }
  $('list').replaceChildren(...items.map(v => el('button', {
    class: 'item', type: 'button', title: 'Открыть и сделать клип',
    onclick: async () => {
      await chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${v.id}&vqclip=1` });
      window.close();
    },
  },
  el('div', { class: 'thumb' },
    el('img', { src: v.thumb, alt: '', loading: 'lazy' }),
    v.badge && el('span', { class: 'badge' + (v.live ? ' live' : ''), text: v.badge })),
  el('div', { class: 'info' },
    el('span', { class: 'title', text: v.title }),
    v.meta && el('span', { class: 'meta', text: v.meta }),
    el('span', { class: 'cta', text: '✂ Сделать клип' })))));
}

async function load() {
  const { channel = DEFAULT_CHANNEL } = await chrome.storage.local.get('channel');
  $('chanLabel').textContent = channel;
  $('chanInput').value = channel;
  skeleton();
  try {
    const id = await resolveChannel(channel);
    const data = await yt('browse', { browseId: id, params: STREAMS_TAB });
    const seen = new Set();
    render(collect(data, []).filter(v => v.id && !seen.has(v.id) && seen.add(v.id)));
  } catch (err) {
    message(el('b', { text: 'Не удалось загрузить список.' }), el('br'), err.message || String(err));
  }
}

$('refresh').addEventListener('click', load);
$('chanForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  await chrome.storage.local.set({ channel: normalizeChannel($('chanInput').value) });
  load();
});
load();
