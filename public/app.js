'use strict';
/* AI Video Studio dashboard. All DOM is built with textContent (no innerHTML) so user text cannot inject markup. */
(() => {
  const $app = document.getElementById('app');
  const $toasts = document.getElementById('toasts');
  const state = { csrf: null, overview: null, videos: [], view: 'create', keys: [], settings: null, form: null, timer: null };

  /* ---------------------------------------------------------------- helpers */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const svg = (d) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true'); const p = document.createElementNS(s.namespaceURI, 'path'); p.setAttribute('d', d); s.append(p); return s; };
  const ICONS = { create: 'M12 5v14M5 12h14', library: 'M4 6h16M4 12h16M4 18h10', settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z' };

  function toast(msg, ms = 4000) {
    const t = h('div', { class: 'toast' }, msg);
    $toasts.append(t);
    setTimeout(() => t.remove(), ms);
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...(state.csrf ? { 'x-csrf-token': state.csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && path !== '/api/login') { state.csrf = null; render(); throw new Error('Please sign in.'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  const ACTIVE = ['queued', 'generating', 'uploading'];
  const STATUS = {
    queued: ['Queued', 'brand'], generating: ['Generating', 'brand'], ready: ['Awaiting your approval', 'warn'],
    uploading: ['Uploading to YouTube', 'brand'], published: ['Published', 'ok'], failed: ['Failed', 'err'], rejected: ['Rejected', ''],
  };
  const badge = (s) => { const [t, c] = STATUS[s] || [s, '']; return h('span', { class: `badge ${c}` }, t); };
  const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '–');
  const fmtSize = (b) => (b ? `${(b / 1048576).toFixed(1)} MB` : '–');
  const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  /* --------------------------------------------------------------- loading */
  async function refreshVideos() {
    state.videos = (await api('GET', '/api/videos')).videos;
    schedulePoll();
  }
  async function loadAll() {
    const [ov, vids, keys, st] = await Promise.all([api('GET', '/api/overview'), api('GET', '/api/videos'), api('GET', '/api/keys'), api('GET', '/api/settings')]);
    Object.assign(state, { overview: ov, videos: vids.videos, keys: keys.keys, settings: st.settings });
    schedulePoll();
  }
  function schedulePoll() {
    clearTimeout(state.timer);
    if (state.videos.some((v) => ACTIVE.includes(v.status))) {
      state.timer = setTimeout(async () => {
        try { await refreshVideos(); if (state.csrf && !document.querySelector('.modal-bg') && state.view === 'library') render(); else updateOpenModal(); } catch { /* retry next tick */ }
      }, 2500);
    }
  }

  /* ----------------------------------------------------------------- views */
  function renderLogin(err) {
    const pw = h('input', { type: 'password', id: 'pw', autocomplete: 'current-password', required: true, 'aria-describedby': 'loginerr' });
    const msg = h('p', { id: 'loginerr', class: 'notice err', hidden: !err }, err || '');
    $app.replaceChildren(h('div', { class: 'login' }, h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/api/login', { password: pw.value });
        state.csrf = r.csrf;
        await loadAll();
        render();
      } catch (ex) { renderLogin(ex.message); }
    } },
    h('div', { class: 'row' }, h('span', { class: 'logo' }, '▶'), h('div', {}, h('h2', {}, 'AI Video Studio'), h('p', { class: 'muted small' }, 'Sign in to your dashboard'))),
    msg,
    h('label', {}, 'Password', pw),
    h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'))));
    pw.focus();
  }

  function shell(content) {
    const tabs = [['create', 'Create'], ['library', 'Videos'], ['settings', 'Settings']];
    const go = (v) => () => { state.view = v; render(); window.scrollTo(0, 0); };
    const waiting = state.videos.filter((v) => v.status === 'ready').length;
    return h('div', { class: 'shell' },
      h('header', { class: 'topbar' },
        h('span', { class: 'logo' }, '▶'), h('span', { class: 'brand' }, 'AI Video Studio'),
        h('nav', { class: 'nav', 'aria-label': 'Main' }, tabs.map(([id, label]) => h('button', { type: 'button', 'aria-current': state.view === id ? 'page' : null, onclick: go(id) }, label, id === 'library' && waiting ? ` (${waiting})` : ''))),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', type: 'button', onclick: async () => { try { await api('POST', '/api/logout'); } catch { /* ignore */ } state.csrf = null; render(); } }, 'Sign out')),
      h('main', {}, content),
      h('nav', { class: 'tabbar', 'aria-label': 'Main' }, tabs.map(([id, label]) => h('button', { type: 'button', 'aria-current': state.view === id ? 'page' : null, onclick: go(id) }, svg(ICONS[id]), label + (id === 'library' && waiting ? ` (${waiting})` : '')))));
  }

  function seg(name, options, value, onchange) {
    return h('div', { class: 'seg', role: 'radiogroup' }, options.map(([v, label]) => {
      const input = h('input', { type: 'radio', name, value: v, checked: v === value, onchange: () => onchange(v) });
      return h('label', {}, input, h('span', {}, label));
    }));
  }

  function viewCreate() {
    const ov = state.overview;
    const f = (state.form = state.form || { title: '', story: '', language: 'en', format: 'shorts', voiceGender: 'female', captions: true, music: 'ambient-calm' });
    const notes = [];
    if (!ov.tts) notes.push(h('p', { class: 'notice warn' }, 'No text-to-speech key is set. Videos will have captions and music but no spoken voice. Add an OpenAI, ElevenLabs or Google key in Settings.'));
    if (!ov.ai.scenes) notes.push(h('p', { class: 'notice' }, 'Tip: add an Anthropic key in Settings for smarter scene planning. Without it the story is split by sentences.'));
    const story = h('textarea', { id: 'story', placeholder: f.language === 'hi' ? 'अपनी कहानी यहाँ लिखें…' : 'Paste or write your story here…', oninput: (e) => { f.story = e.target.value; counter.textContent = `${f.story.length} / ${ov.limits.storyMax}`; } });
    story.value = f.story;
    const counter = h('span', { class: 'muted small' }, `${f.story.length} / ${ov.limits.storyMax}`);
    const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Generate video');

    const form = h('form', { class: 'card stack', onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        await api('POST', '/api/videos', f);
        state.form = null;
        await refreshVideos();
        state.view = 'library';
        toast('Generating. You will review it before anything goes to YouTube.');
        render();
      } catch (ex) { toast(ex.message, 6000); submit.disabled = false; }
    } },
    h('h2', {}, 'New video'),
    h('label', {}, 'Title (optional)', h('input', { type: 'text', maxlength: 100, value: f.title, oninput: (e) => { f.title = e.target.value; } })),
    h('label', {}, 'Story', story, counter),
    h('div', { class: 'cols2' },
      h('label', {}, 'Language', seg('language', [['en', 'English'], ['hi', 'हिन्दी']], f.language, (v) => { f.language = v; story.placeholder = v === 'hi' ? 'अपनी कहानी यहाँ लिखें…' : 'Paste or write your story here…'; })),
      h('label', {}, 'Voice', seg('voice', [['female', 'Female'], ['male', 'Male']], f.voiceGender, (v) => { f.voiceGender = v; }))),
    h('label', {}, 'Format', seg('format', [['shorts', 'Short 9:16'], ['long', 'Long 16:9']], f.format, (v) => { f.format = v; })),
    h('label', {}, 'Background music', h('select', { onchange: (e) => { f.music = e.target.value; } }, ov.music.map((m) => h('option', { value: m.id, selected: m.id === f.music }, m.name)))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.captions, onchange: (e) => { f.captions = e.target.checked; } }), 'Add subtitles'),
    submit);

    const side = h('div', { class: 'stack' },
      h('div', { class: 'card stack' }, h('h3', {}, 'Status'),
        statusLine('Voiceover', ov.tts ? `On (${ov.tts})` : 'Not configured', !!ov.tts),
        statusLine('Scene planning', ov.ai.scenes ? 'AI' : 'Simple splitting', ov.ai.scenes),
        statusLine('Cloud storage', ov.storage.configured ? 'Connected' : 'Local only', ov.storage.configured),
        statusLine('YouTube', ov.youtube.connected ? (ov.youtube.channel ? ov.youtube.channel.title : 'Connected') : 'Not connected', ov.youtube.connected)),
      h('div', { class: 'card stack' }, h('h3', {}, 'How it works'),
        h('p', { class: 'small muted' }, '1. Write a story, pick language and format.'),
        h('p', { class: 'small muted' }, '2. The studio narrates, captions and renders it.'),
        h('p', { class: 'small muted' }, '3. You watch it, then approve. Nothing is uploaded to YouTube without your approval.')));
    return h('div', { class: 'stack' }, notes, h('div', { class: 'grid2' }, form, side));
  }
  const statusLine = (k, v, ok) => h('div', { class: 'row' }, h('span', { class: `badge ${ok ? 'ok' : ''}` }, ok ? 'On' : 'Off'), h('span', {}, h('strong', {}, k), ' · ', v));

  function viewLibrary() {
    if (!state.videos.length) return h('div', { class: 'card empty' }, h('p', {}, 'No videos yet.'), h('p', {}, h('button', { class: 'btn primary', type: 'button', onclick: () => { state.view = 'create'; render(); } }, 'Create your first video')));
    return h('div', { class: 'stack' }, h('h2', {}, 'Videos'), h('div', { class: 'vgrid' }, state.videos.map((v) => {
      const thumb = h('div', { class: 'thumb' });
      if (v.hasFile && v.status !== 'queued' && v.status !== 'generating') thumb.append(h('img', { src: `/api/videos/${v.id}/thumb`, alt: '', loading: 'lazy' })); else thumb.append(v.status === 'failed' ? 'Failed' : 'Working…');
      return h('button', { class: 'card vcard', type: 'button', onclick: () => openVideo(v.id), 'aria-label': `Open ${v.title}` },
        thumb,
        h('div', {}, h('strong', {}, v.title)),
        h('div', { class: 'row' }, badge(v.status), h('span', { class: 'small muted' }, `${v.format === 'shorts' ? '9:16' : '16:9'} · ${v.language === 'hi' ? 'Hindi' : 'English'}${v.duration ? ' · ' + fmtDur(v.duration) : ''}`)),
        ACTIVE.includes(v.status) ? h('div', {}, h('div', { class: 'progress' }, h('i', { style: `width:${Math.round((v.progress || 0) * 100)}%` })), h('p', { class: 'small muted' }, v.stage || '')) : null);
    })));
  }

  /* -------------------------------------------------------------- settings */
  function viewSettings() {
    const yt = state.overview.youtube;
    const s = state.settings;
    const stg = s.storage;

    const ytCard = h('div', { class: 'card stack' },
      h('h3', {}, 'YouTube'),
      yt.connected ? h('p', { class: 'notice ok' }, `Connected${yt.channel ? ': ' + yt.channel.title : ''}`) : h('p', { class: 'notice' }, yt.configured ? 'Not connected yet.' : 'First add your Google OAuth client ID and secret below.'),
      h('p', { class: 'small muted' }, 'Redirect URI to register in Google Cloud Console:'),
      h('code', { class: 'small', style: 'word-break:break-all' }, yt.redirectUri),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', disabled: !yt.configured, onclick: async () => { try { const r = await api('POST', '/api/youtube/connect'); location.href = r.url; } catch (e) { toast(e.message, 6000); } } }, yt.connected ? 'Reconnect' : 'Connect YouTube'),
        yt.connected ? h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (!confirm('Disconnect YouTube? Stored tokens will be deleted and revoked.')) return; await api('POST', '/api/youtube/disconnect'); await loadAll(); render(); } }, 'Disconnect') : null));

    const LABELS = {
      ANTHROPIC_API_KEY: ['Anthropic', 'Smarter scene planning'], OPENAI_API_KEY: ['OpenAI', 'Voiceover (TTS) and optional AI images'],
      ELEVENLABS_API_KEY: ['ElevenLabs', 'Voiceover (TTS)'], GOOGLE_TTS_API_KEY: ['Google Cloud TTS', 'Voiceover (TTS)'],
      YOUTUBE_CLIENT_ID: ['Google OAuth client ID', 'For YouTube'], YOUTUBE_CLIENT_SECRET: ['Google OAuth client secret', 'For YouTube'],
      S3_ACCESS_KEY_ID: ['Storage access key ID', 'Cloud storage'], S3_SECRET_ACCESS_KEY: ['Storage secret access key', 'Cloud storage'],
    };
    const keysCard = h('div', { class: 'card stack' },
      h('div', {}, h('h3', {}, 'API keys'), h('p', { class: 'small muted' }, 'Keys are encrypted on the server and never shown again after saving. Only the last 4 characters are displayed.')),
      h('div', {}, state.keys.map((k) => {
        const input = h('input', { type: 'password', autocomplete: 'off', placeholder: k.configured ? 'Enter a new value to replace' : 'Paste key', 'aria-label': LABELS[k.name][0] });
        return h('div', { class: 'keyrow' },
          h('div', { class: 'row' }, h('strong', {}, LABELS[k.name][0]), k.configured ? h('span', { class: 'badge ok' }, `Saved ${k.hint}${k.source === 'env' ? ' (env)' : ''}`) : h('span', { class: 'badge' }, 'Not set'), h('span', { class: 'small muted' }, LABELS[k.name][1])),
          h('form', { onsubmit: async (e) => { e.preventDefault(); if (!input.value.trim()) return; try { const r = await api('PUT', `/api/keys/${k.name}`, { value: input.value.trim() }); input.value = ''; state.keys = r.keys; await loadAll(); toast('Saved'); render(); } catch (ex) { toast(ex.message, 6000); } } },
            input, h('button', { class: 'btn small primary', type: 'submit' }, 'Save'),
            k.source === 'vault' ? h('button', { class: 'btn small danger', type: 'button', onclick: async () => { if (!confirm(`Remove ${LABELS[k.name][0]}?`)) return; const r = await api('DELETE', `/api/keys/${k.name}`); state.keys = r.keys; await loadAll(); render(); } }, 'Remove') : null));
      })));

    const f = { endpoint: stg.endpoint, region: stg.region, bucket: stg.bucket, prefix: stg.prefix, pathStyle: stg.pathStyle };
    const storageCard = h('form', { class: 'card stack', onsubmit: async (e) => { e.preventDefault(); try { const r = await api('PUT', '/api/settings', { storage: f }); state.settings = r.settings; await loadAll(); toast('Storage settings saved'); render(); } catch (ex) { toast(ex.message, 6000); } } },
      h('div', {}, h('h3', {}, 'Cloud storage'), h('p', { class: 'small muted' }, 'Any S3-compatible service (Cloudflare R2, AWS S3, Backblaze B2, Supabase…). Add the access key ID and secret above.')),
      h('label', {}, 'Endpoint', h('input', { type: 'url', placeholder: 'https://<account>.r2.cloudflarestorage.com', value: f.endpoint, oninput: (e) => { f.endpoint = e.target.value; } })),
      h('div', { class: 'cols2' },
        h('label', {}, 'Bucket', h('input', { type: 'text', value: f.bucket, oninput: (e) => { f.bucket = e.target.value; } })),
        h('label', {}, 'Region', h('input', { type: 'text', value: f.region, oninput: (e) => { f.region = e.target.value; } }))),
      h('label', {}, 'Folder prefix', h('input', { type: 'text', value: f.prefix, oninput: (e) => { f.prefix = e.target.value; } })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.pathStyle, onchange: (e) => { f.pathStyle = e.target.checked; } }), 'Path-style URLs (leave on for R2, MinIO, B2)'),
      h('button', { class: 'btn primary', type: 'submit' }, 'Save storage settings'));

    const prefs = { ttsProvider: s.ttsProvider, imageMode: s.imageMode, markSyntheticMedia: s.markSyntheticMedia };
    const prefCard = h('form', { class: 'card stack', onsubmit: async (e) => { e.preventDefault(); try { const r = await api('PUT', '/api/settings', prefs); state.settings = r.settings; await loadAll(); toast('Saved'); render(); } catch (ex) { toast(ex.message, 6000); } } },
      h('h3', {}, 'Generation'),
      h('label', {}, 'Voiceover provider', h('select', { onchange: (e) => { prefs.ttsProvider = e.target.value; } }, [['auto', 'Automatic (first key found)'], ['elevenlabs', 'ElevenLabs'], ['openai', 'OpenAI'], ['google', 'Google Cloud TTS'], ['none', 'No voice (captions only)']].map(([v, l]) => h('option', { value: v, selected: v === prefs.ttsProvider }, l)))),
      h('label', {}, 'Scene visuals', h('select', { onchange: (e) => { prefs.imageMode = e.target.value; } }, [['gradient', 'Animated gradients (free)'], ['ai', 'AI images (needs OpenAI key, costs per image)']].map(([v, l]) => h('option', { value: v, selected: v === prefs.imageMode }, l)))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: prefs.markSyntheticMedia, onchange: (e) => { prefs.markSyntheticMedia = e.target.checked; } }), 'Label uploads as AI-generated on YouTube'),
      h('button', { class: 'btn primary', type: 'submit' }, 'Save'));

    const musicCard = musicLibraryCard();
    return h('div', { class: 'stack' }, h('h2', {}, 'Settings'), h('div', { class: 'grid2' }, h('div', { class: 'stack' }, ytCard, keysCard), h('div', { class: 'stack' }, storageCard, prefCard, musicCard)));
  }

  function musicLibraryCard() {
    const list = h('div', { class: 'stack' });
    const load = async () => {
      const r = await api('GET', '/api/music');
      list.replaceChildren(...(r.music.length ? r.music.map((m) => h('div', { class: 'row' }, h('span', {}, m.name), h('span', { class: 'small muted' }, fmtSize(m.size)), h('span', { class: 'spacer' }), h('button', { class: 'btn small danger', type: 'button', onclick: async () => { await api('DELETE', `/api/music/${m.id}`); await loadAll(); load(); } }, 'Delete'))) : [h('p', { class: 'small muted' }, 'No uploaded tracks.')]));
    };
    load().catch(() => {});
    const file = h('input', { type: 'file', accept: '.mp3,.wav,.m4a,.ogg,audio/*', class: 'sr', id: 'musicfile', onchange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const res = await fetch('/api/music', { method: 'POST', headers: { 'x-csrf-token': state.csrf, 'x-filename': encodeURIComponent(f.name), 'content-type': 'application/octet-stream' }, body: f });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error);
        await loadAll(); await load(); toast('Track added');
      } catch (ex) { toast(ex.message, 6000); }
      e.target.value = '';
    } });
    return h('div', { class: 'card stack' }, h('div', {}, h('h3', {}, 'Your music'), h('p', { class: 'small muted' }, 'Only upload music you have the rights to use. Max 30 MB.')), list, file, h('label', { for: 'musicfile', class: 'btn', role: 'button', tabindex: 0, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } } }, 'Upload track'));
  }

  /* ------------------------------------------------------------ video modal */
  let openId = null;
  async function openVideo(id) {
    openId = id;
    await drawModal();
  }
  function closeModal() { openId = null; document.querySelector('.modal-bg')?.remove(); render(); }
  async function updateOpenModal() { if (openId && document.querySelector('.modal-bg')) { const v = state.videos.find((x) => x.id === openId); const cur = document.querySelector('.modal'); if (v && cur && cur.dataset.status !== v.status) drawModal(); else if (v && ACTIVE.includes(v.status)) { const bar = document.querySelector('.modal .progress > i'); if (bar) bar.style.width = `${Math.round((v.progress || 0) * 100)}%`; const st = document.querySelector('.modal [data-stage]'); if (st) st.textContent = v.stage || ''; } } }

  async function drawModal() {
    let v;
    try { v = (await api('GET', `/api/videos/${openId}`)).video; } catch (e) { toast(e.message); closeModal(); return; }
    document.querySelector('.modal-bg')?.remove();
    const yt = state.overview.youtube;
    const body = [];
    body.push(h('div', { class: 'row' }, h('h2', {}, v.title), h('span', { class: 'spacer' }), h('button', { class: 'btn small', type: 'button', onclick: closeModal }, 'Close')));
    body.push(h('div', { class: 'row' }, badge(v.status), h('span', { class: 'small muted' }, `${v.format === 'shorts' ? 'Short 9:16' : 'Long 16:9'} · ${v.language === 'hi' ? 'Hindi' : 'English'} · ${fmtDur(v.duration)} · ${fmtSize(v.size)}`)));
    if (v.error) body.push(h('p', { class: 'notice err' }, v.error));
    for (const w of v.warnings || []) body.push(h('p', { class: 'notice warn' }, w));
    if (ACTIVE.includes(v.status)) body.push(h('div', {}, h('div', { class: 'progress' }, h('i', { style: `width:${Math.round((v.progress || 0) * 100)}%` })), h('p', { class: 'small muted', 'data-stage': true }, v.stage || '')));
    if (v.hasFile || v.inCloud) body.push(h('div', { class: v.format === 'shorts' ? 'thumb tall' : '' }, h('video', { class: 'player', controls: true, playsinline: true, preload: 'metadata', src: `/api/videos/${v.id}/file`, poster: `/api/videos/${v.id}/thumb` })));
    if (v.status === 'published' && v.youtube) body.push(h('p', { class: 'notice ok' }, 'Uploaded as ', v.youtube.privacy, ': ', h('a', { href: v.youtube.url, target: '_blank', rel: 'noopener noreferrer' }, v.youtube.url)));

    if (v.status === 'ready') body.push(approvalForm(v, yt));
    const actions = [];
    if (v.hasFile || v.inCloud) actions.push(h('a', { class: 'btn', href: `/api/videos/${v.id}/file?download=1` }, 'Download'));
    if (['ready', 'failed', 'rejected'].includes(v.status) && v.status !== 'rejected') actions.push(h('button', { class: 'btn', type: 'button', onclick: async () => { try { await api('POST', `/api/videos/${v.id}/retry`); await refreshVideos(); await drawModal(); } catch (e) { toast(e.message, 6000); } } }, 'Regenerate'));
    if (!ACTIVE.includes(v.status)) actions.push(h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (!confirm('Delete this video from the server and cloud storage?')) return; try { await api('DELETE', `/api/videos/${v.id}`); await refreshVideos(); closeModal(); } catch (e) { toast(e.message, 6000); } } }, 'Delete'));
    if (actions.length) body.push(h('div', { class: 'row' }, actions));
    body.push(h('details', {}, h('summary', {}, `Scenes (${v.scenes.length})`), h('ol', {}, v.scenes.map((s) => h('li', {}, s.narration)))));
    body.push(h('dl', { class: 'kv' }, h('dt', {}, 'Created'), h('dd', {}, fmtDate(v.createdAt)), h('dt', {}, 'Cloud copy'), h('dd', {}, v.inCloud ? 'Saved' : 'Not saved')));

    const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': v.title, 'data-status': v.status }, body);
    const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) closeModal(); } }, modal);
    document.body.append(bg);
    schedulePoll();
  }

  function approvalForm(v, yt) {
    const m = { title: v.title, description: '', tags: '', privacy: 'private', ok: false };
    const go = h('button', { class: 'btn primary', type: 'submit', disabled: true }, 'Approve and upload to YouTube');
    const ack = h('input', { type: 'checkbox', onchange: (e) => { m.ok = e.target.checked; go.disabled = !m.ok || !yt.connected; } });
    return h('form', { class: 'card stack', onsubmit: async (e) => {
      e.preventDefault();
      if (!m.ok) return;
      go.disabled = true;
      try {
        await api('POST', `/api/videos/${v.id}/approve`, { confirm: true, title: m.title, description: m.description, tags: m.tags, privacy: m.privacy });
        toast('Approved. Uploading to YouTube…');
        await refreshVideos();
        await drawModal();
      } catch (ex) { toast(ex.message, 7000); go.disabled = false; }
    } },
    h('h3', {}, 'Review and approve'),
    !yt.connected ? h('p', { class: 'notice warn' }, 'Connect YouTube in Settings before you can upload.') : h('p', { class: 'small muted' }, `Channel: ${yt.channel ? yt.channel.title : 'connected'}. Nothing is uploaded until you tick the box and approve.`),
    h('label', {}, 'YouTube title', h('input', { type: 'text', maxlength: 100, value: m.title, required: true, oninput: (e) => { m.title = e.target.value; } })),
    h('label', {}, 'Description', h('textarea', { style: 'min-height:90px', oninput: (e) => { m.description = e.target.value; } })),
    h('label', {}, 'Tags (comma separated)', h('input', { type: 'text', oninput: (e) => { m.tags = e.target.value; } })),
    h('label', {}, 'Visibility', h('select', { onchange: (e) => { m.privacy = e.target.value; } }, [['private', 'Private (recommended for first upload)'], ['unlisted', 'Unlisted'], ['public', 'Public']].map(([val, l]) => h('option', { value: val }, l)))),
    h('label', { class: 'check' }, ack, 'I have watched this video and approve uploading it.'),
    h('div', { class: 'row' }, go, h('button', { class: 'btn', type: 'button', onclick: async () => { try { await api('POST', `/api/videos/${v.id}/reject`); await refreshVideos(); await drawModal(); } catch (e) { toast(e.message, 6000); } } }, 'Reject')));
  }

  /* ------------------------------------------------------------------ main */
  function render() {
    if (!state.csrf) return renderLogin();
    const views = { create: viewCreate, library: viewLibrary, settings: viewSettings };
    $app.replaceChildren(shell(views[state.view]()));
  }

  async function boot() {
    const q = new URLSearchParams(location.search);
    try {
      const s = await fetch('/api/session', { credentials: 'same-origin' }).then((r) => r.json());
      if (s.authenticated) { state.csrf = s.csrf; await loadAll(); }
    } catch { /* show login */ }
    if (q.has('youtube')) {
      state.view = 'settings';
      history.replaceState(null, '', '/');
      setTimeout(() => toast(q.get('msg') || (q.get('youtube') === 'connected' ? 'YouTube connected' : 'YouTube connection failed'), 7000), 100);
    }
    render();
  }
  boot();
})();
