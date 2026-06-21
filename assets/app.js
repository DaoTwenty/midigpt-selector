/* ── State ───────────────────────────────────────────────── */
let SONGS = [];          // from songs.json
let song  = null;        // currently selected song entry
let queue = [];          // [{song, secA, secB}, …]
let audio = null;        // HTMLAudioElement

// Sections in BAR units (floats)
let secA = { start: 0, end: 8 };
let secB = { start: 16, end: 24 };

// Drag state
let drag = null;         // {handle: 'a-start'|'a-end'|'b-start'|'b-end', startX, origVal}
let playStopAt = null;   // setTimeout id for auto-stop

/* ── Boot ────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", async () => {
  try {
    const res = await fetch("songs.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    SONGS = data.songs ?? data;
  } catch (e) {
    document.getElementById("main").innerHTML =
      `<div class="welcome"><div class="icon">⚠️</div>
       <h2>Could not load songs.json</h2><p>${e.message}</p></div>`;
    return;
  }

  document.getElementById("stat-songs").textContent = SONGS.length;

  document.getElementById("search").addEventListener("input", e => {
    renderSongList(e.target.value.toLowerCase(),
                   document.getElementById("genre-filter").value);
  });
  document.getElementById("genre-filter").addEventListener("change", e => {
    renderSongList(document.getElementById("search").value.toLowerCase(), e.target.value);
  });

  buildGenreFilter();
  renderSongList("", "");
  renderWelcome();
  renderQueue();
});

/* ── Sidebar ─────────────────────────────────────────────── */
function buildGenreFilter() {
  const genres = new Set();
  SONGS.forEach(s => {
    (s.style || "").split(",").forEach(g => {
      const t = g.trim();
      if (t) genres.add(t);
    });
  });
  const sel = document.getElementById("genre-filter");
  [...genres].sort().forEach(g => {
    const o = document.createElement("option");
    o.value = g; o.textContent = g;
    sel.appendChild(o);
  });
}

function renderSongList(query, genre) {
  const list = document.getElementById("song-list");
  let songs = SONGS;
  if (query) songs = songs.filter(s =>
    s.title.toLowerCase().includes(query) ||
    s.artist.toLowerCase().includes(query));
  if (genre) songs = songs.filter(s => (s.style || "").includes(genre));

  list.innerHTML = songs.map(s => {
    const bpm  = s.bpm ? Math.round(s.bpm) + " BPM" : "";
    const trk  = s.num_tracks ? s.num_tracks + " trk" : "";
    const act  = s.slug === song?.slug ? " active" : "";
    return `<li class="song-item${act}" data-slug="${s.slug}"
                onclick="selectSong('${s.slug}')">
      <div class="si-title">${s.artist} — ${s.title}</div>
      <div class="si-meta">${[bpm, trk, s.style?.split(",")[0]].filter(Boolean).join(" · ")}</div>
    </li>`;
  }).join("") || `<li style="padding:20px 14px;color:var(--muted);font-size:13px">No songs match</li>`;
}

/* ── Song selection ──────────────────────────────────────── */
function selectSong(slug) {
  song = SONGS.find(s => s.slug === slug);
  if (!song) return;

  document.querySelectorAll(".song-item").forEach(el =>
    el.classList.toggle("active", el.dataset.slug === slug));

  stopAudio();

  // Default sections: A = bars 1–9, B = bars 17–25 (reasonable starting point)
  const nb = song.n_bars ?? 32;
  secA = { start: 1,          end: Math.min(9,  Math.floor(nb * 0.3)) };
  secB = { start: Math.min(17, Math.floor(nb * 0.55)),
           end:   Math.min(25, Math.floor(nb * 0.80)) };

  renderSongView();
}

/* ── Song view ───────────────────────────────────────────── */
function renderSongView() {
  if (!song) return;
  const main = document.getElementById("main");
  const nb   = song.n_bars ?? 32;
  const bpm  = song.bpm ?? 120;
  const insts = (song.instruments ?? []).slice(0, 5).join(", ");

  main.innerHTML = `
    <div class="song-header">
      <h1>${song.artist} — ${song.title}</h1>
      <div class="sub">
        <span>♩ ${Math.round(bpm)} BPM</span>
        <span>≈ ${nb} bars</span>
        <span>${song.num_tracks ?? "?"} tracks</span>
        <span>${(song.style||"").split(",")[0]}</span>
        <span style="color:var(--muted)">${insts}</span>
      </div>
    </div>

    <div class="audio-card">
      <h3>Timeline — drag handles to set sections</h3>
      <audio id="audio-el" src="${song.audio_url ?? ""}"></audio>
      <div class="timeline-wrap">
        <div class="tl-bar" id="tl-bar">
          <div class="tl-region sec-a" id="tl-reg-a"><span class="region-label">A</span></div>
          <div class="tl-region sec-b" id="tl-reg-b"><span class="region-label">B</span></div>
          <div class="tl-playhead" id="tl-playhead" style="left:0"></div>
          <div class="tl-handle a-start" id="h-a-start" title="A start"></div>
          <div class="tl-handle a-end"   id="h-a-end"   title="A end"></div>
          <div class="tl-handle b-start" id="h-b-start" title="B start"></div>
          <div class="tl-handle b-end"   id="h-b-end"   title="B end"></div>
        </div>
        <div class="tl-ruler" id="tl-ruler"></div>
      </div>

      <div class="section-info">
        <div class="sec-box sec-a-box">
          <div class="sec-name">Section A</div>
          <div class="sec-range" id="disp-a">bars — → —</div>
          <div class="sec-dur"   id="dur-a">— sec</div>
          <div class="play-row">
            <button class="btn-play a" onclick="playSection('a')">▶ Play A</button>
            <button class="btn-play stop" onclick="stopAudio()">■ Stop</button>
          </div>
        </div>
        <div class="sec-box sec-b-box">
          <div class="sec-name">Section B</div>
          <div class="sec-range" id="disp-b">bars — → —</div>
          <div class="sec-dur"   id="dur-b">— sec</div>
          <div class="play-row">
            <button class="btn-play b" onclick="playSection('b')">▶ Play B</button>
            <button class="btn-play stop" onclick="stopAudio()">■ Stop</button>
          </div>
        </div>
      </div>

      <button class="btn-add" id="btn-add" onclick="addToQueue()">
        + Add pair to queue
      </button>
    </div>`;

  audio = document.getElementById("audio-el");
  audio.addEventListener("timeupdate", onTimeUpdate);
  audio.addEventListener("error", () => {
    if (audio.error) console.warn("Audio error:", audio.error.message);
  });

  buildRuler(nb);
  initDrag();
  updateTimeline();
}

/* ── Ruler ───────────────────────────────────────────────── */
function buildRuler(nBars) {
  const ruler = document.getElementById("tl-ruler");
  if (!ruler) return;
  const step = nBars <= 32 ? 4 : nBars <= 64 ? 8 : 16;
  let html = "";
  for (let b = 0; b <= nBars; b += step) {
    const pct = (b / nBars * 100).toFixed(2);
    html += `<span class="tl-tick" style="left:${pct}%">${b}</span>`;
  }
  ruler.innerHTML = html;
}

/* ── Timeline update ─────────────────────────────────────── */
function updateTimeline() {
  const nb  = song?.n_bars ?? 32;
  const bpm = song?.bpm    ?? 120;
  const bar2pct = b => Math.max(0, Math.min(100, b / nb * 100));
  const bar2sec = b => b * (60 / bpm) * 4;

  // Regions
  const setRegion = (el, s, e) => {
    el.style.left  = bar2pct(s) + "%";
    el.style.width = bar2pct(e - s) + "%";
  };
  const ra = document.getElementById("tl-reg-a");
  const rb = document.getElementById("tl-reg-b");
  if (ra) setRegion(ra, secA.start, secA.end);
  if (rb) setRegion(rb, secB.start, secB.end);

  // Handles
  const setHandle = (id, bar) => {
    const el = document.getElementById(id);
    if (el) el.style.left = bar2pct(bar) + "%";
  };
  setHandle("h-a-start", secA.start);
  setHandle("h-a-end",   secA.end);
  setHandle("h-b-start", secB.start);
  setHandle("h-b-end",   secB.end);

  // Text displays
  const fmt = b => Math.round(b);
  const fmtSec = s => s.toFixed(1) + "s";
  const da = document.getElementById("disp-a");
  const db = document.getElementById("disp-b");
  const dua = document.getElementById("dur-a");
  const dub = document.getElementById("dur-b");
  if (da)  da.textContent  = `bars ${fmt(secA.start)} → ${fmt(secA.end)}  (${fmt(secA.end - secA.start)} bars)`;
  if (db)  db.textContent  = `bars ${fmt(secB.start)} → ${fmt(secB.end)}  (${fmt(secB.end - secB.start)} bars)`;
  if (dua) dua.textContent = fmtSec(bar2sec(secA.end - secA.start));
  if (dub) dub.textContent = fmtSec(bar2sec(secB.end - secB.start));
}

/* ── Drag handles ────────────────────────────────────────── */
function initDrag() {
  const bar = document.getElementById("tl-bar");
  if (!bar) return;

  const handles = ["h-a-start", "h-a-end", "h-b-start", "h-b-end"];
  handles.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("mousedown", e => {
      e.preventDefault();
      const nb = song?.n_bars ?? 32;
      const rect = bar.getBoundingClientRect();
      const type = id.replace("h-", "");  // 'a-start', 'a-end', etc.
      drag = { type, rect, nb };
      document.body.style.cursor = "col-resize";
    });
  });

  document.addEventListener("mousemove", e => {
    if (!drag) return;
    const nb   = drag.nb;
    const pct  = Math.max(0, Math.min(1, (e.clientX - drag.rect.left) / drag.rect.width));
    const bar  = Math.round(pct * nb);
    const MIN  = 2;  // minimum section width in bars
    const GAP  = 1;  // minimum gap between A and B in bars

    if (drag.type === "a-start") {
      secA.start = Math.min(bar, secA.end - MIN);
    } else if (drag.type === "a-end") {
      secA.end = Math.max(bar, secA.start + MIN);
      // Push B forward if needed
      if (secA.end + GAP > secB.start) {
        const shift = secA.end + GAP - secB.start;
        secB.start = Math.min(secB.start + shift, nb - MIN);
        secB.end   = Math.min(secB.end   + shift, nb);
      }
    } else if (drag.type === "b-start") {
      secB.start = Math.max(bar, secA.end + GAP);
      secB.start = Math.min(secB.start, secB.end - MIN);
    } else if (drag.type === "b-end") {
      secB.end = Math.max(bar, secB.start + MIN);
      secB.end = Math.min(secB.end, nb);
    }

    updateTimeline();
  });

  document.addEventListener("mouseup", () => {
    if (!drag) return;
    drag = null;
    document.body.style.cursor = "";
  });

  // Click on bar = seek audio
  bar.addEventListener("click", e => {
    if (!audio || !song) return;
    const rect = bar.getBoundingClientRect();
    const pct  = (e.clientX - rect.left) / rect.width;
    const nb   = song.n_bars ?? 32;
    const bpm  = song.bpm    ?? 120;
    audio.currentTime = pct * nb * (60 / bpm) * 4;
    audio.play().catch(() => {});
  });
}

/* ── Playhead ────────────────────────────────────────────── */
function onTimeUpdate() {
  if (!audio || !song) return;
  const nb  = song.n_bars ?? 32;
  const bpm = song.bpm    ?? 120;
  const totalSec = nb * (60 / bpm) * 4;
  const pct = (audio.currentTime / totalSec * 100).toFixed(2);
  const ph  = document.getElementById("tl-playhead");
  if (ph) ph.style.left = pct + "%";
}

/* ── Audio playback ──────────────────────────────────────── */
function barToSec(bar) {
  const bpm = song?.bpm ?? 120;
  return bar * (60 / bpm) * 4;
}

function playSection(which) {
  if (!audio || !song) return;
  if (!song.audio_url) {
    alert("No audio file available for this song yet.");
    return;
  }
  clearTimeout(playStopAt);

  const sec = which === "a" ? secA : secB;
  const startSec = barToSec(sec.start);
  const endSec   = barToSec(sec.end);

  audio.currentTime = startSec;
  audio.play().catch(err => console.warn("Play failed:", err));

  // Auto-stop at section end
  playStopAt = setTimeout(() => audio.pause(), (endSec - startSec) * 1000);
}

function stopAudio() {
  clearTimeout(playStopAt);
  if (audio) { audio.pause(); }
}

/* ── Queue ───────────────────────────────────────────────── */
function addToQueue() {
  if (!song) return;
  queue.push({
    slug:    song.slug,
    artist:  song.artist,
    title:   song.title,
    bpm:     song.bpm,
    midi:    song.midi_path ?? "",
    secA:    { ...secA },
    secB:    { ...secB },
    addedAt: Date.now(),
  });
  renderQueue();
}

function removeFromQueue(idx) {
  queue.splice(idx, 1);
  renderQueue();
}

function clearQueue() {
  if (!queue.length) return;
  if (!confirm("Clear all queued pairs?")) return;
  queue = [];
  renderQueue();
}

function renderQueue() {
  const cnt  = document.getElementById("queue-count");
  const list = document.getElementById("queue-list");
  const btn  = document.getElementById("btn-export");
  if (cnt) cnt.textContent = queue.length;
  if (btn) btn.disabled = queue.length === 0;

  if (!list) return;
  if (!queue.length) {
    list.innerHTML = `<div class="queue-empty">No pairs yet.<br>Select sections and click<br>"Add pair to queue".</div>`;
    return;
  }
  list.innerHTML = queue.map((q, i) => `
    <div class="queue-item">
      <button class="qi-remove" onclick="removeFromQueue(${i})">✕</button>
      <div class="qi-title">${q.artist} — ${q.title}</div>
      <div class="qi-range">
        <span class="pill a">A ${Math.round(q.secA.start)}→${Math.round(q.secA.end)}</span>
        <span class="pill b">B ${Math.round(q.secB.start)}→${Math.round(q.secB.end)}</span>
      </div>
    </div>`).join("");
}

function exportQueue() {
  if (!queue.length) return;

  const pairs = queue.map((q, i) => ({
    dataset:  "gigamidi",
    id:       `${q.slug}__pair${i + 1}`,
    midi:     q.midi,
    bpm:      q.bpm,
    sec_a:    [Math.round(q.secA.start), Math.round(q.secA.end)],
    sec_b:    [Math.round(q.secB.start), Math.round(q.secB.end)],
  }));

  const config = {
    _note:       "Generated by midigpt-selector. Feed into unified_transition.py or transition_pipeline.py.",
    out_dir:     "out/selected_run/runs",
    n_generations: 2,
    gap_bars:    4,
    window_bars: 4,
    temperature: 0.9,
    matching:    "group",
    device:      "cuda",
    transcribe:  true,
    exp_id:      "mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b80_ps2",
    pairs,
  };

  const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), { href: url, download: "transition_config.json" });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function renderWelcome() {
  document.getElementById("main").innerHTML = `
    <div class="welcome">
      <div class="icon">🎛️</div>
      <h2>MIDI-GPT Pair Selector</h2>
      <p>Pick a song from the sidebar, drag the <span style="color:var(--sec-a)">blue (A)</span>
         and <span style="color:var(--sec-b)">green (B)</span> handles to set your sections,
         preview with Play buttons, then add pairs to the queue and export.</p>
    </div>`;
}
