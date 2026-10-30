// Vibe Clips: перехват кусков видео, которые плеер YouTube кладёт в MediaSource,
// и сборка из них MP4 без пережатия — клип не нужно проигрывать в реальном времени.
// Работает в контексте страницы (world: MAIN) и запускается до загрузки плеера.
(() => {
  'use strict';
  if (window.__vqClipper) return;

  // ---------- 1. Просим YouTube отдавать H.264 + AAC ----------
  // Только такие куски (fragmented MP4) можно склеить в обычный MP4 без пережатия.
  // У YouTube H.264 бывает до 1080p включительно.
  const NOT_MP4 = /vp0?9|av01|opus|vorbis|webm/i;
  const isTypeSupported = MediaSource.isTypeSupported.bind(MediaSource);
  MediaSource.isTypeSupported = type => !NOT_MP4.test(type) && isTypeSupported(type);
  const canPlayType = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function (type) {
    return NOT_MP4.test(type) ? '' : canPlayType.call(this, type);
  };

  // ---------- 2. Хранилище перехваченных кадров ----------
  const MAX_BYTES = 300 * 1024 * 1024; // сколько видео держим в памяти (~10 минут 1080p)
  const store = { videoId: null, inits: new Map(), fifo: [], bytes: 0, ver: 0 };
  const debug = { sourceBuffers: 0, skipped: 0, appends: 0, appendedMB: 0, resets: 0 };
  let initSeq = 0;

  const player = () => document.getElementById('movie_player');
  const currentVideoId = () => { try { return player()?.getVideoData?.().video_id || null; } catch { return null; } };
  const str4 = (u8, p) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
  const view = u8 => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  function clearStore(videoId) {
    store.videoId = videoId;
    store.inits.clear();
    store.fifo = [];
    store.bytes = 0;
    store.ver++;
  }

  // ---------- 3. Разбор MP4-боксов ----------
  function* boxes(u8, start, end) {
    const dv = view(u8);
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p), hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) return;
      yield { type: str4(u8, p + 4), start: p, end: p + size, body: p + hdr };
      p += size;
    }
  }
  const child = (u8, parent, type) => {
    for (const b of boxes(u8, parent.body, parent.end)) if (b.type === type) return b;
    return null;
  };
  const path = (u8, root, ...types) => types.reduce((b, t) => b && child(u8, b, t), root);

  function hash(u8) {
    let h = 0x811c9dc5;
    for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 0x01000193);
    return (h >>> 0).toString(36);
  }

  function parseInit(moov) {
    const dv = view(moov);
    const root = { body: 8, end: moov.length };
    const trak = child(moov, root, 'trak');
    const tkhd = trak && child(moov, trak, 'tkhd');
    const mdhd = trak && path(moov, trak, 'mdia', 'mdhd');
    const hdlr = trak && path(moov, trak, 'mdia', 'hdlr');
    const stsd = trak && path(moov, trak, 'mdia', 'minf', 'stbl', 'stsd');
    if (!tkhd || !mdhd || !hdlr || !stsd) return null;
    const trackId = dv.getUint32(tkhd.body + 4 + (moov[tkhd.body] === 1 ? 16 : 8));
    const timescale = dv.getUint32(mdhd.body + 4 + (moov[mdhd.body] === 1 ? 16 : 8));
    const kind = str4(moov, hdlr.body + 8) === 'soun' ? 'audio' : 'video';
    const entry = boxes(moov, stsd.body + 8, stsd.end).next().value;
    let trex = { dur: 0, size: 0, flags: 0 };
    const mvex = child(moov, root, 'mvex');
    if (mvex) {
      for (const b of boxes(moov, mvex.body, mvex.end)) {
        if (b.type === 'trex' && dv.getUint32(b.body + 4) === trackId) {
          trex = { dur: dv.getUint32(b.body + 12), size: dv.getUint32(b.body + 16), flags: dv.getUint32(b.body + 20) };
        }
      }
    }
    const stsdBytes = moov.slice(stsd.start, stsd.end);
    return {
      kind, trackId, timescale, trex, stsd: stsdBytes, codec: entry?.type || '?',
      width: Math.round(dv.getUint32(tkhd.end - 8) / 65536),
      height: Math.round(dv.getUint32(tkhd.end - 4) / 65536),
      key: kind + timescale + hash(stsdBytes),
    };
  }

  // Одинаковый init (то же качество после перемотки) — один и тот же набор кадров.
  function registerInit(info) {
    // Кадры рекламы помечаем и в клипы не берём.
    info.ad = !!player()?.classList.contains('ad-showing');
    info.key += info.ad ? ':ad' : '';
    const vid = currentVideoId();
    if (vid && vid !== store.videoId) clearStore(vid);
    let init = [...store.inits.values()].find(i => i.key === info.key);
    if (!init) {
      init = { ...info, id: ++initSeq, samples: new Map() };
      store.inits.set(init.id, init);
    }
    return init;
  }

  function addSample(init, smp) {
    const old = init.samples.get(smp.dts);
    if (old) store.bytes -= old.data.length;
    init.samples.set(smp.dts, smp);
    store.bytes += smp.data.length;
    store.ver++;
    store.fifo.push([init.id, smp.dts, smp]);
    while (store.bytes > MAX_BYTES && store.fifo.length) {
      const [id, dts, s] = store.fifo.shift();
      const i = store.inits.get(id);
      if (i && i.samples.get(dts) === s) { i.samples.delete(dts); store.bytes -= s.data.length; }
    }
  }

  function addFragment(init, moof, mdat, tso) {
    const dv = view(moof);
    for (const traf of boxes(moof, 8, moof.length)) {
      if (traf.type !== 'traf') continue;
      const tfhd = child(moof, traf, 'tfhd');
      const tfdt = child(moof, traf, 'tfdt');
      if (!tfhd || !tfdt) continue;
      const tf = (moof[tfhd.body + 1] << 16) | (moof[tfhd.body + 2] << 8) | moof[tfhd.body + 3];
      if (tf & 0x1) continue; // абсолютные смещения в файле — в потоке MSE не встречаются
      let p = tfhd.body + 8;
      if (tf & 0x2) p += 4;
      let defDur = init.trex.dur, defSize = init.trex.size, defFlags = init.trex.flags;
      if (tf & 0x8) { defDur = dv.getUint32(p); p += 4; }
      if (tf & 0x10) { defSize = dv.getUint32(p); p += 4; }
      if (tf & 0x20) { defFlags = dv.getUint32(p); p += 4; }
      let dts = moof[tfdt.body] === 1 ? Number(dv.getBigUint64(tfdt.body + 4)) : dv.getUint32(tfdt.body + 4);
      let cursor = moof.length + 8; // данные сразу за заголовком mdat
      for (const trun of boxes(moof, traf.body, traf.end)) {
        if (trun.type !== 'trun') continue;
        const fl = (moof[trun.body + 1] << 16) | (moof[trun.body + 2] << 8) | moof[trun.body + 3];
        let q = trun.body + 4;
        const count = dv.getUint32(q); q += 4;
        if (fl & 0x1) { cursor = dv.getInt32(q); q += 4; }
        let firstFlags = null;
        if (fl & 0x4) { firstFlags = dv.getUint32(q); q += 4; }
        for (let i = 0; i < count; i++) {
          let dur = defDur, size = defSize, flags = i === 0 && firstFlags != null ? firstFlags : defFlags, cto = 0;
          if (fl & 0x100) { dur = dv.getUint32(q); q += 4; }
          if (fl & 0x200) { size = dv.getUint32(q); q += 4; }
          if (fl & 0x400) { flags = dv.getUint32(q); q += 4; }
          if (fl & 0x800) { cto = dv.getInt32(q); q += 4; }
          const at = cursor - moof.length;
          if (at < 8 || at + size > mdat.length) return;
          addSample(init, {
            dts, dur, cto, tso,
            key: init.kind === 'audio' || !(flags & 0x10000),
            data: mdat.subarray(at, at + size),
          });
          cursor += size;
          dts += dur;
        }
      }
    }
  }

  // Плеер кладёт поток кусками произвольной длины — собираем из них целые боксы.
  class BoxStream {
    constructor() { this.chunks = []; this.len = 0; this.moof = null; this.init = null; }
    reset() { this.chunks = []; this.len = 0; this.moof = null; debug.resets++; }
    head(n) {
      const out = new Uint8Array(Math.min(n, this.len));
      let o = 0;
      for (const c of this.chunks) {
        const k = Math.min(c.length, out.length - o);
        out.set(c.subarray(0, k), o);
        o += k;
        if (o >= out.length) break;
      }
      return out;
    }
    take(n) {
      const first = this.chunks[0];
      let out;
      if (first.length >= n) {
        out = first.subarray(0, n);
        if (first.length === n) this.chunks.shift(); else this.chunks[0] = first.subarray(n);
      } else {
        out = new Uint8Array(n);
        let o = 0;
        while (o < n) {
          const c = this.chunks[0], k = Math.min(c.length, n - o);
          out.set(c.subarray(0, k), o);
          o += k;
          if (k === c.length) this.chunks.shift(); else this.chunks[0] = c.subarray(k);
        }
      }
      this.len -= n;
      return out;
    }
    push(u8, tso) {
      this.chunks.push(u8);
      this.len += u8.length;
      while (this.len >= 8) {
        const h = this.head(16);
        let size = view(h).getUint32(0);
        const type = str4(h, 4);
        if (!/^[a-z0-9 ]{4}$/i.test(type)) return this.reset(); // поток сбился — ждём следующий init
        if (size === 1) { if (h.length < 16) return; size = Number(view(h).getBigUint64(8)); }
        if (size < 8) return this.reset();
        if (this.len < size) return;
        this.onBox(type, this.take(size), tso);
      }
    }
    onBox(type, box, tso) {
      if (type === 'moov') {
        const info = parseInit(box);
        this.init = info && registerInit(info);
        this.moof = null;
      } else if (type === 'moof') {
        this.moof = box;
      } else if (type === 'mdat') {
        if (this.moof && this.init && store.inits.get(this.init.id) === this.init) addFragment(this.init, this.moof, box, tso);
        this.moof = null;
      }
    }
  }

  // ---------- 4. Перехват MediaSource ----------
  const streams = new WeakMap();
  const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = addSourceBuffer.call(this, mime);
    try {
      debug.sourceBuffers++;
      if (/mp4/i.test(mime)) streams.set(sb, new BoxStream()); else debug.skipped++;
    } catch {}
    return sb;
  };
  const appendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const result = appendBuffer.call(this, data); // если плеер не принял кусок — исключение, и мы его не берём
    try {
      const st = streams.get(this);
      if (st) {
        const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        debug.appends++;
        debug.appendedMB += u8.length / 1048576;
        st.push(u8.slice(), this.timestampOffset);
      }
    } catch (err) { console.debug('[Vibe Clips] capture:', err); }
    return result;
  };
  const abort = SourceBuffer.prototype.abort;
  SourceBuffer.prototype.abort = function () {
    try { streams.get(this)?.reset(); } catch {}
    return abort.call(this);
  };

  // ---------- 5. Что из нужного отрезка уже есть ----------
  const sorted = init => [...init.samples.values()].sort((a, b) => a.dts - b.dts);
  const T = (init, s) => s.dts / init.timescale + s.tso;
  const Tend = (init, s) => (s.dts + s.dur) / init.timescale + s.tso;

  function coverageOf(init, s, e) {
    const arr = sorted(init);
    const needKey = init.kind === 'video';
    let i0 = -1;
    for (let i = 0; i < arr.length && T(init, arr[i]) <= s + 1e-6; i++) if (!needKey || arr[i].key) i0 = i;
    if (i0 < 0) return { ok: false, from: s, covered: 0, arr };
    let end = Tend(init, arr[i0]);
    let i = i0 + 1;
    for (; i < arr.length && end < e; i++) {
      if (T(init, arr[i]) > end + 0.05) break; // разрыв
      end = Math.max(end, Tend(init, arr[i]));
    }
    const covered = Math.min(end, e) - s;
    return end >= e - 0.01 ? { ok: true, i0, end, covered, arr } : { ok: false, from: Math.max(s, end), covered, arr };
  }

  // Лучший набор кадров: полностью покрывает отрезок и с наибольшим разрешением.
  function pick(kind, s, e, minSide) {
    let best = null;
    for (const init of store.inits.values()) {
      if (init.kind !== kind || init.ad) continue;
      if (kind === 'video' && minSide && Math.min(init.width, init.height) < minSide) continue;
      const c = coverageOf(init, s, e);
      const score = (c.ok ? 1e9 : 0) + c.covered * 1e4 + (kind === 'video' ? init.width * init.height / 1e3 : 0);
      if (!best || score > best.score) best = { init, c, score };
    }
    return best;
  }

  function coverage(s, e, minSide = 0) {
    const v = pick('video', s, e, minSide), a = pick('audio', s, e);
    const vFrom = v ? (v.c.ok ? e : v.c.from) : s, aFrom = a ? (a.c.ok ? e : a.c.from) : s;
    const from = Math.min(vFrom, aFrom);
    return {
      ok: !!(v?.c.ok && a?.c.ok),
      from,
      progress: Math.max(0, Math.min(1, (from - s) / (e - s))),
      width: v?.init.width || 0,
      height: v?.init.height || 0,
    };
  }

  // Последний непрерывный кусок одного качества (видео — с ключевого кадра).
  function lastRun(init) {
    const arr = sorted(init);
    let i = arr.length - 1;
    if (i < 0) return null;
    while (i > 0 && T(init, arr[i]) <= Tend(init, arr[i - 1]) + 0.05) i--;
    if (init.kind === 'video') while (i < arr.length && !arr[i].key) i++;
    return i < arr.length ? { start: T(init, arr[i]), end: Tend(init, arr.at(-1)) } : null;
  }

  // Что можно вырезать без перемотки: самый свежий кусок, где есть и видео, и звук.
  let rangeCache = { ver: -1, r: null };
  function range() {
    if (rangeCache.ver === store.ver) return rangeCache.r;
    const freshest = kind => {
      let r = null;
      for (const init of store.inits.values()) {
        if (init.kind !== kind || init.ad) continue;
        const run = lastRun(init);
        if (run && (!r || run.end > r.end + 0.5 || (run.end > r.end - 0.5 && run.start < r.start))) r = run;
      }
      return r;
    };
    const v = freshest('video'), a = freshest('audio');
    const start = Math.max(v?.start ?? Infinity, a?.start ?? Infinity), end = Math.min(v?.end ?? 0, a?.end ?? 0);
    rangeCache = { ver: store.ver, r: end > start ? { start, end } : null };
    return rangeCache.r;
  }

  // ---------- 6. Сборка MP4 ----------
  const te = new TextEncoder();
  const u16 = n => new Uint8Array([n >> 8 & 255, n & 255]);
  const u32 = n => { const b = new Uint8Array(4); view(b).setUint32(0, n >>> 0); return b; };
  const i32 = n => { const b = new Uint8Array(4); view(b).setInt32(0, n); return b; };
  const u32s = arr => { const b = new Uint8Array(arr.length * 4), dv = view(b); arr.forEach((n, i) => dv.setUint32(i * 4, n >>> 0)); return b; };
  const zeros = n => new Uint8Array(n);
  function box(type, ...parts) {
    parts = parts.flat(Infinity).filter(Boolean);
    const size = 8 + parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(size);
    view(out).setUint32(0, size);
    out.set(te.encode(type), 4);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  const full = (type, version, flags, ...parts) => box(type, new Uint8Array([version, flags >> 16 & 255, flags >> 8 & 255, flags & 255]), ...parts);
  const MATRIX = u32s([0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]);
  const MOVIE_TS = 1000;

  function runs(values) {
    const out = [];
    for (const v of values) {
      const last = out[out.length - 1];
      if (last && last[1] === v) last[0]++; else out.push([1, v]);
    }
    return out;
  }

  function trak(t, trackId, offsets) {
    const video = t.kind === 'video';
    const n = t.samples.length;
    const stts = runs(t.samples.map(s => s.dur));
    const ctsRuns = runs(t.samples.map(s => s.cto));
    const hasCtts = ctsRuns.some(([, v]) => v !== 0);
    const stbl = box('stbl',
      t.init.stsd,
      full('stts', 0, 0, u32(stts.length), stts.map(([c, d]) => [u32(c), u32(d)])),
      hasCtts && full('ctts', ctsRuns.some(([, v]) => v < 0) ? 1 : 0, 0, u32(ctsRuns.length), ctsRuns.map(([c, o]) => [u32(c), i32(o)])),
      video && full('stss', 0, 0, u32(t.samples.filter(s => s.key).length), t.samples.flatMap((s, i) => (s.key ? [u32(i + 1)] : []))),
      full('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)),
      full('stsz', 0, 0, u32(0), u32(n), u32s(t.samples.map(s => s.data.length))),
      full('stco', 0, 0, u32(n), u32s(offsets)),
    );
    const mediaDur = t.samples.reduce((s, x) => s + x.dur, 0);
    return box('trak',
      full('tkhd', 0, 3, u32(0), u32(0), u32(trackId), u32(0), u32(t.segment), zeros(8),
        u16(0), u16(0), u16(video ? 0 : 0x0100), u16(0), MATRIX,
        u32(video ? t.init.width * 65536 : 0), u32(video ? t.init.height * 65536 : 0)),
      // Точное начало без пережатия: кадры от ключевого до «Начала» есть в файле, но не показываются.
      box('edts', full('elst', 0, 0, u32(1), u32(t.segment), i32(t.mediaTime), u16(1), u16(0))),
      box('mdia',
        full('mdhd', 0, 0, u32(0), u32(0), u32(t.init.timescale), u32(mediaDur), u16(0x55c4), u16(0)),
        full('hdlr', 0, 0, u32(0), te.encode(video ? 'vide' : 'soun'), zeros(12), te.encode(video ? 'VideoHandler\0' : 'SoundHandler\0')),
        box('minf',
          video ? full('vmhd', 0, 1, zeros(8)) : full('smhd', 0, 0, zeros(4)),
          box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
          stbl)));
  }

  function build(s, e, minSide = 0) {
    const v = pick('video', s, e, minSide), a = pick('audio', s, e);
    if (!v?.c.ok || !a?.c.ok) throw new Error('Фрагмент ещё не загружен целиком.');
    const segment = Math.round((e - s) * MOVIE_TS);
    const tracks = [v, a].map(({ init, c }) => {
      const samples = [];
      for (let i = c.i0; i < c.arr.length && T(init, c.arr[i]) < e; i++) samples.push(c.arr[i]);
      const first = samples[0];
      return {
        init, kind: init.kind, samples, segment,
        mediaTime: Math.max(0, Math.round((s - first.tso) * init.timescale) - first.dts),
        dts0: first.dts,
      };
    });
    // Кадры видео и звука в mdat чередуем по времени — так файл нормально играет с диска.
    const order = [];
    tracks.forEach((t, ti) => t.samples.forEach((smp, k) => order.push({ ti, k, smp, at: T(t.init, smp) })));
    order.sort((x, y) => x.at - y.at);

    const ftyp = box('ftyp', te.encode('isom'), u32(0x200), te.encode('isomiso2avc1mp41'));
    const moovFor = offsets => box('moov',
      full('mvhd', 0, 0, u32(0), u32(0), u32(MOVIE_TS), u32(segment), u32(0x10000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(3)),
      tracks.map((t, i) => trak(t, i + 1, offsets[i])));
    // Размер moov не зависит от значений смещений — считаем его с нулями, потом подставляем настоящие.
    const mdatStart = ftyp.length + moovFor(tracks.map(t => t.samples.map(() => 0))).length + 8;
    const stco = tracks.map(t => new Array(t.samples.length));
    let pos = mdatStart;
    for (const { ti, k, smp } of order) { stco[ti][k] = pos; pos += smp.data.length; }
    const moov = moovFor(stco);
    const blob = new Blob([ftyp, moov, u32(pos - mdatStart + 8), te.encode('mdat'), ...order.map(o => o.smp.data)], { type: 'video/mp4' });
    return { blob, width: v.init.width, height: v.init.height, seconds: e - s };
  }

  Object.defineProperty(window, '__vqClipper', {
    value: Object.freeze({
      version: 2,
      coverage,
      range,
      build,
      stats: () => ({
        videoId: store.videoId,
        megabytes: +(store.bytes / 1048576).toFixed(1),
        ...debug,
        appendedMB: +debug.appendedMB.toFixed(1),
        inits: [...store.inits.values()].map(i => `${i.ad ? 'AD ' : ''}${i.kind} ${i.codec} ${i.width}x${i.height} @${i.timescale}: ${i.samples.size}`),
      }),
    }),
  });
})();
