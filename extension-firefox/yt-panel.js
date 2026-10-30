// Vibe Clips: панель клипа под плеером на странице YouTube.
// Ползунок начала и конца, точное время, просмотр фрагмента и скачивание MP4.
// Сами кадры берёт yt-capture.js: плеер на паузе догружает нужный кусок, проигрывать его не надо.
(() => {
  'use strict';
  if (window.__vqPanel) return;
  Object.defineProperty(window, '__vqPanel', { value: true });

  const MIN_LEN = 1;
  const QUALITY_SIDE = { tiny: 144, small: 240, medium: 360, large: 480, hd720: 720, hd1080: 1080, hd1440: 1440, hd2160: 2160 };

  // ---------- утилиты ----------
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const round1 = t => Math.round(t * 10) / 10;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const player = () => document.getElementById('movie_player');
  const isWatchPage = () => /^\/(watch|live\/)/.test(location.pathname);

  function fmt(t, tenths) {
    t = Math.max(0, t || 0);
    const whole = Math.floor(t + 1e-6);
    const h = Math.floor(whole / 3600), m = Math.floor(whole % 3600 / 60), s = whole % 60;
    let out = (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
    if (tenths) out += '.' + Math.floor((t - whole) * 10 + 1e-6);
    return out;
  }
  function parseTime(str) {
    const parts = String(str).trim().replace(',', '.').split(':');
    if (parts.length > 3 || parts.some(p => p === '' || isNaN(p))) return NaN;
    return parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
  }

  // YouTube требует Trusted Types для innerHTML, поэтому всё собираем из элементов.
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(shapes, opts = {}) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', opts.fill ? 'currentColor' : 'none');
    s.setAttribute('stroke', opts.fill ? 'none' : 'currentColor');
    s.setAttribute('stroke-width', opts.width || '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of shapes) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      s.append(el);
    }
    return s;
  }
  const ICONS = {
    scissors: [['circle', { cx: 6, cy: 6, r: 3 }], ['circle', { cx: 6, cy: 18, r: 3 }], ['path', { d: 'M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12' }]],
    close: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
    play: [['path', { d: 'M8 5v14l11-7z' }]],
    download: [['path', { d: 'M12 4v11M7 10l5 5 5-5M5 20h14' }]],
  };

  // ---------- состояние ----------
  const st = {
    open: false, s: 0, e: 0, t: 0, D: 0, D0: 0, off: 0, live: false, noSeek: false, touched: false, hinted: false, known: false, videoId: null,
    view: null, previewEnd: null, dragging: false, busy: false, cancel: false, tick: null, rulerKey: '', lastUrl: null,
  };
  const E = {};

  // ---------- разметка ----------
  function buildPanel() {
    E.hs = h('div', { class: 'vqc-handle vqc-hs', role: 'slider', tabindex: '0', 'aria-label': 'Начало клипа' });
    E.he = h('div', { class: 'vqc-handle vqc-he', role: 'slider', tabindex: '0', 'aria-label': 'Конец клипа' });
    E.range = h('div', { class: 'vqc-range', title: 'Перетащите, чтобы сдвинуть фрагмент' });
    E.playhead = h('div', { class: 'vqc-playhead' });
    E.tip = h('div', { class: 'vqc-tip', hidden: true });
    E.track = h('div', { class: 'vqc-track' }, E.range, E.playhead, E.hs, E.he, E.tip);
    E.ruler = h('div', { class: 'vqc-ruler' });
    E.startIn = h('input', { class: 'vqc-time', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Начало' });
    E.endIn = h('input', { class: 'vqc-time', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Конец' });
    E.len = h('b', { text: '0:00' });
    E.live = h('span', { class: 'vqc-live', text: 'ЭФИР', hidden: true });
    E.zoom = h('button', { class: 'vqc-btn vqc-ghost vqc-sm', type: 'button', text: 'Приблизить' });
    E.preview = h('button', { class: 'vqc-btn vqc-ghost', type: 'button' }, icon(ICONS.play, { fill: true }), 'Просмотреть');
    E.make = h('button', { class: 'vqc-btn vqc-primary', type: 'button' }, icon(ICONS.download, { width: '2.4' }), 'Скачать клип');
    E.cancel = h('button', { class: 'vqc-btn vqc-ghost', type: 'button', text: 'Отменить', hidden: true });
    E.fill = h('div', { class: 'vqc-fill' });
    E.bar = h('div', { class: 'vqc-bar', hidden: true }, E.fill);
    E.status = h('div', { class: 'vqc-status' });
    const nudge = (k, d) => h('button', { class: 'vqc-nudge', type: 'button', title: (d > 0 ? '+' : '−') + '1 секунда', text: (d > 0 ? '+' : '−') + '1с', onclick: () => setBound(k, (k === 's' ? st.s : st.e) + d, true) });

    E.panel = h('section', { class: 'vqc-panel', 'aria-label': 'Клип' },
      h('div', { class: 'vqc-head' },
        h('span', { class: 'vqc-logo' }, icon(ICONS.scissors)),
        h('b', { class: 'vqc-title', text: 'Клип' }),
        E.live,
        h('span', { class: 'vqc-spacer' }),
        E.zoom,
        h('button', { class: 'vqc-icon', type: 'button', title: 'Закрыть', 'aria-label': 'Закрыть', onclick: close }, icon(ICONS.close, { width: '2.2' }))),
      h('div', { class: 'vqc-timeline' }, E.ruler, E.track),
      h('div', { class: 'vqc-bounds' },
        h('div', { class: 'vqc-bound' },
          h('div', { class: 'vqc-bound-head' },
            h('span', { class: 'vqc-label', text: 'Начало' }),
            h('button', { class: 'vqc-btn vqc-sm', type: 'button', title: 'Начало — текущий момент видео', text: '⇤ Отсюда', onclick: () => setBound('s', st.t, false) })),
          h('div', { class: 'vqc-bound-row' }, nudge('s', -1), E.startIn, nudge('s', 1))),
        h('div', { class: 'vqc-len' }, h('span', { class: 'vqc-label', text: 'Длина' }), E.len),
        h('div', { class: 'vqc-bound vqc-end' },
          h('div', { class: 'vqc-bound-head' },
            h('button', { class: 'vqc-btn vqc-sm', type: 'button', title: 'Конец — текущий момент видео', text: 'Досюда ⇥', onclick: () => setBound('e', st.t, false) }),
            h('span', { class: 'vqc-label', text: 'Конец' })),
          h('div', { class: 'vqc-bound-row' }, nudge('e', -1), E.endIn, nudge('e', 1)))),
      h('div', { class: 'vqc-actions' },
        h('div', { class: 'vqc-progress' }, E.status, E.bar),
        E.preview, E.cancel, E.make));

    bindDrag(E.hs, 's');
    bindDrag(E.he, 'e');
    bindDrag(E.range, 'range');
    bindDrag(E.track, 'seek');
    bindDrag(E.ruler, 'seek');
    E.track.addEventListener('pointermove', ev => {
      if (!st.known) return;
      const r = E.track.getBoundingClientRect();
      E.tip.style.left = clamp(ev.clientX - r.left, 0, r.width) + 'px';
      E.tip.textContent = fmt(fromX(ev.clientX));
      E.tip.hidden = false;
    });
    E.track.addEventListener('pointerleave', () => { E.tip.hidden = true; });
    for (const [node, k] of [[E.hs, 's'], [E.he, 'e']]) {
      node.addEventListener('keydown', ev => {
        const step = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
        let d = 0;
        if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') d = -step;
        else if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') d = step;
        else return;
        ev.preventDefault();
        ev.stopPropagation(); // иначе YouTube перемотает видео на 5 секунд
        setBound(k, (k === 's' ? st.s : st.e) + d, true);
      });
    }
    for (const [input, k] of [[E.startIn, 's'], [E.endIn, 'e']]) {
      input.addEventListener('change', () => {
        const t = parseTime(input.value);
        if (isNaN(t)) {
          input.classList.add('vqc-bad');
          setTimeout(() => input.classList.remove('vqc-bad'), 700);
        } else setBound(k, t, true);
        input.value = fmt(k === 's' ? st.s : st.e, true);
      });
      input.addEventListener('keydown', ev => {
        ev.stopPropagation(); // буквы в поле не должны срабатывать как горячие клавиши YouTube
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
      });
      input.addEventListener('focus', () => input.select());
    }
    E.zoom.addEventListener('click', () => {
      if (st.view) st.view = null;
      else {
        const pad = Math.max(5, (st.e - st.s) * 0.6);
        st.view = [Math.max(st.D0, st.s - pad), Math.min(st.D, st.e + pad)];
      }
      E.zoom.textContent = st.view ? 'Всё видео' : 'Приблизить';
      st.rulerKey = '';
      draw();
    });
    E.preview.addEventListener('click', () => {
      const p = player();
      if (!p || st.busy) return;
      st.previewEnd = st.e;
      p.seekTo(st.s, true);
      p.playVideo();
    });
    E.make.addEventListener('click', makeClip);
    E.cancel.addEventListener('click', () => { st.cancel = true; });
  }

  // ---------- кнопка в плеере ----------
  function ensureButton() {
    const controls = document.querySelector('#movie_player .ytp-right-controls');
    if (!controls || controls.querySelector('.vqc-ytp-btn')) return;
    const btn = h('button', { class: 'ytp-button vqc-ytp-btn', title: 'Клип (Vibe Clips)', 'aria-label': 'Сделать клип' }, icon(ICONS.scissors));
    btn.addEventListener('click', () => (st.open ? close() : open()));
    controls.prepend(btn);
  }

  // ---------- открыть / закрыть ----------
  function mount() {
    if (!E.panel) buildPanel();
    const below = document.querySelector('ytd-watch-flexy #below');
    if (below) {
      if (E.panel.nextElementSibling !== below) below.parentNode.insertBefore(E.panel, below);
      E.panel.classList.remove('vqc-floating');
    } else if (!E.panel.isConnected) {
      document.body.append(E.panel);
      E.panel.classList.add('vqc-floating');
    }
  }

  function open() {
    const p = player();
    if (!p || !isWatchPage()) return;
    mount();
    st.open = true;
    E.panel.hidden = false;
    resetForVideo();
    startTick();
    E.panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function close() {
    if (st.busy) st.cancel = true;
    st.open = false;
    st.previewEnd = null;
    stopTick();
    if (E.panel) E.panel.hidden = true;
  }

  function resetForVideo() {
    const p = player();
    st.videoId = p?.getVideoData?.().video_id || null;
    st.view = null;
    st.known = st.noSeek = st.touched = st.hinted = false;
    st.D = st.D0 = st.off = 0;
    st.rulerKey = '';
    E.zoom.textContent = 'Приблизить';
    setStatus('');
    readPlayer();
    initSelection();
    draw();
  }

  function readPlayer() {
    const p = player();
    if (!p?.getCurrentTime) return;
    const vd = p.getVideoData?.() || {};
    st.live = !!vd.isLive;
    if (!st.dragging) st.t = p.getCurrentTime() || 0;
    if (!st.live) {
      const d = p.getDuration() || 0;
      if (d > 0) { st.D = d; st.D0 = st.off = 0; st.known = true; }
      return;
    }
    // В эфире getDuration() — край эфира плюс примерно час запаса, поэтому берём отрезок, доступный для перемотки.
    // Во время рекламы getProgressState() описывает рекламный ролик.
    if (p.classList.contains('ad-showing')) return;
    const ps = p.getProgressState?.();
    const dvr = p.getPlayerResponse?.()?.videoDetails?.isLiveDvrEnabled;
    st.noSeek = dvr === false || (dvr == null && ps?.allowSeeking === false);
    if (st.noSeek) {
      // Перемотка отключена (seekable* всё равно описывают 12 часов): доступно только то, что уже загружено.
      st.off = ps?.offset || 0;
      const r = window.__vqClipper?.range?.();
      st.known = !!r && r.end - r.start >= MIN_LEN;
      if (st.known) { st.D0 = r.start + st.off; st.D = r.end + st.off; }
    } else if (ps?.seekableEnd > 0) {
      st.D0 = ps.seekableStart || 0;
      st.D = Math.max(ps.seekableEnd, st.t);
      // Плеер считает время от начала эфира, а видео в памяти — от начала доступной записи.
      st.off = ps.offset || 0;
      st.known = true;
    } else if (st.t > 0) {
      const b = p.querySelector('video')?.buffered;
      st.D = Math.max(st.t, b?.length ? b.end(b.length - 1) : 0);
      st.known = true;
    }
  }

  function initSelection() {
    if (!st.known) { st.s = st.e = 0; return; }
    if (st.live) {
      st.e = round1(Math.min(st.D, Math.max(st.t, st.D0 + 30)));
      st.s = round1(Math.max(st.D0, st.e - 30));
    } else {
      st.s = round1(st.t);
      st.e = round1(Math.min(st.D, st.t + 30));
      if (st.e - st.s < MIN_LEN) { st.s = round1(Math.max(0, st.D - 30)); st.e = round1(st.D); }
    }
  }

  function noSeekStarted(p) {
    st.hinted = true;
    setStatus('В этой трансляции перемотка отключена: клип можно сделать только из того, что загрузилось после открытия страницы (до ~10 минут).');
    // Только что открыли — сразу включаем лучшее качество, чтобы оно и попало в клип.
    // Если уже что-то загружено, не трогаем: смена качества начала бы запись заново.
    const best = (p.getAvailableQualityLevels?.() || []).find(q => q !== 'auto');
    if (best && p.getPlaybackQuality?.() !== best && !(st.known && st.D - st.D0 > 5)) p.setPlaybackQualityRange?.(best, best);
  }

  function startTick() { stopTick(); st.tick = setInterval(tick, 150); }
  function stopTick() { clearInterval(st.tick); st.tick = null; }

  function tick() {
    const p = player();
    if (!p?.getCurrentTime) return;
    const vid = p.getVideoData?.().video_id || null;
    if (vid && vid !== st.videoId && !st.busy) resetForVideo();
    const wasKnown = st.known;
    readPlayer();
    if (st.noSeek && !st.hinted) noSeekStarted(p);
    // Без перемотки выделение идёт за эфиром (последние 30 секунд), пока его не поправили вручную.
    if (st.known && (!wasKnown || (st.noSeek && !st.touched && !st.busy && !st.dragging))) initSelection();
    if (st.e > st.D && st.known) { st.e = Math.floor(st.D * 10) / 10; st.s = Math.min(st.s, Math.max(st.D0, st.e - MIN_LEN)); }
    // Начало эфира ушло из доступной записи (YouTube хранит последние ~12 часов).
    if (st.s < st.D0 && st.known && !st.busy) { st.s = Math.ceil(st.D0 * 10) / 10; st.e = Math.max(st.e, round1(st.s + MIN_LEN)); }
    if (st.previewEnd != null && !st.busy && st.t >= st.previewEnd - 0.05) { st.previewEnd = null; p.pauseVideo(); }
    draw();
  }

  // ---------- таймлайн ----------
  const viewRange = () => st.view || [st.D0, Math.max(st.D, st.e, st.D0 + 1)];
  function toPct(t) { const [a, b] = viewRange(); return clamp((t - a) / (b - a) * 100, 0, 100); }
  function fromX(clientX) {
    const r = E.track.getBoundingClientRect(), [a, b] = viewRange();
    return a + clamp((clientX - r.left) / r.width, 0, 1) * (b - a);
  }

  function draw() {
    if (!E.panel || E.panel.hidden) return;
    const [a, b] = viewRange();
    E.track.classList.toggle('vqc-disabled', !st.known || st.busy);
    const ps = toPct(st.s), pe = toPct(st.e);
    E.range.style.left = ps + '%';
    E.range.style.width = Math.max(0, pe - ps) + '%';
    E.hs.style.left = ps + '%';
    E.he.style.left = pe + '%';
    E.playhead.style.left = toPct(st.t) + '%';
    E.playhead.hidden = !st.known || st.t < a || st.t > b;
    E.hs.setAttribute('aria-valuetext', fmt(st.s));
    E.he.setAttribute('aria-valuetext', fmt(st.e));
    if (document.activeElement !== E.startIn) E.startIn.value = st.known ? fmt(st.s, true) : '—';
    if (document.activeElement !== E.endIn) E.endIn.value = st.known ? fmt(st.e, true) : '—';
    E.len.textContent = fmt(st.e - st.s, true);
    E.live.hidden = !st.live;
    E.preview.disabled = E.make.disabled = !st.known || st.busy;
    if (st.noSeek) E.preview.disabled = true;
    E.preview.title = st.noSeek ? 'В этой трансляции перемотка отключена' : '';
    E.zoom.disabled = !st.known;
    E.make.hidden = st.busy;
    E.cancel.hidden = !st.busy;
    drawRuler(a, b);
  }

  function drawRuler(a, b) {
    const width = E.ruler.clientWidth;
    const key = Math.round(a) + '|' + Math.round(b) + '|' + width;
    if (key === st.rulerKey) return;
    st.rulerKey = key;
    E.ruler.replaceChildren();
    const span = b - a;
    if (!st.known || span <= 0) return;
    // Сколько подписей влезает без наложения: у эфиров на сотни часов подписи длинные.
    const fits = clamp(Math.floor(width / (fmt(b).length * 8 + 28)), 2, 7);
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
    let step = steps.find(s => span / s <= fits);
    if (!step) for (step = 172800; span / step > fits;) step *= 2;
    for (let t = Math.ceil(a / step) * step; t <= b + 1e-6; t += step) {
      const pct = (t - a) / span * 100;
      const label = h('span', { text: fmt(t) });
      label.style.left = pct + '%';
      label.style.transform = `translateX(${pct < 4 ? '0' : pct > 96 ? '-100%' : '-50%'})`;
      E.ruler.append(label);
    }
  }

  let lastSeek = 0, seekTimer = null;
  function seekTo(t, final, keepPaused) {
    const p = player();
    if (!p || st.noSeek) return;
    clearTimeout(seekTimer);
    const go = () => {
      lastSeek = performance.now();
      p.seekTo(t, true);
      if (keepPaused) p.pauseVideo();
    };
    if (final || performance.now() - lastSeek > 150) go(); else seekTimer = setTimeout(go, 150);
  }
  const isPlaying = () => [1, 3].includes(player()?.getPlayerState?.());

  function bindDrag(node, kind) {
    node.addEventListener('pointerdown', ev => {
      if (!st.known || st.busy || ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      node.setPointerCapture(ev.pointerId);
      let k = kind, moved = false;
      const x0 = ev.clientX, t0 = fromX(x0), s0 = st.s, e0 = st.e;
      const keepPaused = k !== 'seek' || !isPlaying();
      st.previewEnd = null;
      st.dragging = true;
      if (k !== 'seek') st.touched = true;
      if (k !== 'seek' && isPlaying() && !st.noSeek) player().pauseVideo();
      const apply = (clientX, final) => {
        const t = fromX(clientX);
        if (k === 's') { st.s = round1(clamp(t, st.D0, st.e - MIN_LEN)); st.t = st.s; }
        else if (k === 'e') { st.e = round1(clamp(t, st.s + MIN_LEN, st.D)); st.t = st.e; }
        else if (k === 'range') {
          const len = e0 - s0;
          st.s = round1(clamp(s0 + t - t0, st.D0, st.D - len));
          st.e = round1(st.s + len);
          st.t = st.s;
        } else st.t = clamp(t, st.D0, st.D);
        seekTo(st.t, final, keepPaused);
        draw();
      };
      if (k !== 'range') apply(ev.clientX, false);
      const move = e2 => {
        if (Math.abs(e2.clientX - x0) > 3) moved = true;
        if (k === 'range' && !moved) return;
        apply(e2.clientX, false);
      };
      const end = e2 => {
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', end);
        node.removeEventListener('pointercancel', end);
        if (k === 'range' && !moved) k = 'seek'; // простой клик по выделению — перемотка
        apply(e2.clientX, true);
        st.dragging = false;
      };
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', end);
      node.addEventListener('pointercancel', end);
    });
  }

  function setBound(k, t, seek) {
    if (!st.known || st.busy) return;
    st.touched = true;
    t = round1(clamp(t, st.D0, st.D));
    const len = Math.max(st.e - st.s, MIN_LEN);
    if (k === 's') {
      st.s = Math.min(t, round1(st.D - MIN_LEN));
      // Начало поставили за концом — конец сдвигается следом, длина сохраняется.
      if (st.e - st.s < MIN_LEN) st.e = round1(Math.min(st.D, st.s + len));
    } else {
      st.e = Math.max(t, round1(st.D0 + MIN_LEN));
      if (st.e - st.s < MIN_LEN) st.s = round1(Math.max(st.D0, st.e - len));
    }
    if (seek) { st.t = k === 's' ? st.s : st.e; seekTo(st.t, true, !isPlaying()); }
    draw();
  }

  // ---------- скачивание ----------
  function setStatus(text, type, link) {
    if (!E.status) return;
    E.status.className = 'vqc-status' + (type ? ' vqc-' + type : '');
    E.status.replaceChildren(text);
    if (link) E.status.append(' ', link);
  }

  async function makeClip() {
    const api = window.__vqClipper;
    const p = player();
    if (st.busy || !p) return;
    if (!api) return setStatus('Обновите страницу (F5): расширение подключается при загрузке YouTube.', 'warn');
    const s = st.s, e = st.e;
    // yt-capture.js считает время по самому видео, плеер — со сдвигом st.off (бывает у долгих эфиров).
    const off = st.off, sm = s - off, em = e - off;
    const seekPoint = c => (c.from <= sm ? Math.max(st.D0, s - 0.05) : c.from + off);
    // Без перемотки догрузить нечего: собираем из того, что уже в памяти, и плеер не трогаем.
    const noSeek = st.noSeek;
    st.busy = true;
    st.cancel = false;
    st.previewEnd = null;
    E.bar.hidden = false;
    E.fill.style.width = '0';
    draw();

    const back = { t: p.getCurrentTime(), playing: isPlaying(), muted: p.isMuted(), rate: p.getPlaybackRate?.() || 1 };
    const levels = (p.getAvailableQualityLevels?.() || []).filter(q => q !== 'auto');
    const best = levels[0];
    const minSide = !noSeek && best && QUALITY_SIDE[best] ? QUALITY_SIDE[best] * 0.9 : 0;
    if (!noSeek && best && p.getPlaybackQuality?.() !== best) p.setPlaybackQualityRange?.(best, best);
    let playMode = false;
    try {
      if (!noSeek) p.pauseVideo();
      // Плеер на паузе сам догружает ~20 секунд вперёд от места перемотки.
      // Прыгаем к первому недостающему месту, пока весь отрезок не окажется в памяти.
      let lastFrom = -1, lastMove = Date.now(), needSeek = true, idleSeeks = 0, flowing = false;
      const deadline = Date.now() + 180000;
      for (;;) {
        if (st.cancel) throw new Error('cancel');
        const c = api.coverage(sm, em, minSide);
        E.fill.style.width = Math.round(c.progress * 100) + '%';
        if (c.ok) break;
        if (noSeek) throw new Error('Этого куска нет в памяти. В этой трансляции перемотка отключена — выберите отрезок внутри полосы.');
        if (Date.now() > deadline) throw new Error('YouTube слишком долго не отдаёт этот кусок видео. Попробуйте ещё раз.');
        if (c.from > lastFrom + 0.01) { lastFrom = c.from; lastMove = Date.now(); idleSeeks = 0; flowing = true; }
        setStatus(playMode
          ? `Догружаю с воспроизведением без звука… ${Math.round(c.progress * 100)}%`
          : `Загружаю фрагмент… ${Math.round(c.progress * 100)}%`);
        // После перемотки ждём первых данных подольше, а когда они пошли и затихли — сразу следующий шаг.
        const stallMs = flowing ? 1000 : 4000;
        if (needSeek && !playMode) {
          p.seekTo(seekPoint(c), true);
          p.pauseVideo();
          needSeek = false;
          flowing = false;
          lastMove = Date.now();
        } else if (Date.now() - lastMove > stallMs) {
          if (!playMode && idleSeeks < 1) { needSeek = true; idleSeeks++; }
          else if (!playMode) {
            // На паузе YouTube ничего не качает — догружаем на двойной скорости без звука.
            playMode = true;
            p.mute();
            p.setPlaybackRate?.(2);
            p.seekTo(seekPoint(c), true);
            p.playVideo();
            lastMove = Date.now();
          } else if (!isPlaying()) p.playVideo();
        }
        await sleep(200);
      }
      setStatus('Собираю MP4…');
      await sleep(30);
      const res = api.build(sm, em, minSide);
      const title = (p.getVideoData?.().title || 'clip').replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'clip';
      const tf = t => fmt(t).replace(/:/g, '-');
      const name = `${title} ${tf(s)}_${tf(e)}.mp4`;
      if (st.lastUrl) URL.revokeObjectURL(st.lastUrl);
      st.lastUrl = URL.createObjectURL(res.blob);
      const a = h('a', { href: st.lastUrl, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      const size = (res.blob.size / 1048576).toFixed(1).replace('.', ',');
      setStatus(`Готово: «${name}» · ${res.width}×${res.height} · ${size} МБ.`, 'ok',
        h('a', { href: st.lastUrl, download: name, text: 'Скачать ещё раз' }));
    } catch (err) {
      if (err.message === 'cancel') setStatus('Отменено.');
      else setStatus(err.message || String(err), 'warn');
    } finally {
      st.busy = false;
      st.cancel = false;
      E.bar.hidden = true;
      try {
        if (playMode) { p.setPlaybackRate?.(back.rate); if (!back.muted) p.unMute(); }
        if (!noSeek) {
          p.seekTo(back.t, true);
          if (back.playing) p.playVideo(); else p.pauseVideo();
        }
      } catch {}
      draw();
    }
  }

  // ---------- жизненный цикл на SPA YouTube ----------
  function onPage() {
    if (!isWatchPage()) { close(); return; }
    ensureButton();
    if (new URLSearchParams(location.search).has('vqclip')) {
      // Пришли из окна расширения — открываем панель, как только плеер готов.
      const started = Date.now();
      const wait = setInterval(() => {
        const p = player();
        if (p?.getDuration?.() > 0 || Date.now() - started > 15000) {
          clearInterval(wait);
          if (p) open();
        }
      }, 300);
    } else if (st.open) resetForVideo();
  }
  document.addEventListener('yt-navigate-finish', onPage);
  setInterval(() => { if (isWatchPage()) ensureButton(); }, 1500); // YouTube иногда перерисовывает панель управления
  onPage();
})();
