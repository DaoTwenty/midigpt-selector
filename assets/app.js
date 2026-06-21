/* ── State ───────────────────────────────────────────────── */
let SONGS = [];          // from songs.json
let song  = null;        // currently selected song entry
let queue = [];          // [{song, secA, secB}, …]
let audio = null;        // HTMLAudioElement
let noteData = null;     // loaded from notes/{slug}.json for piano roll
let canvasRO = null;     // ResizeObserver for canvas

// Sections in BAR units (floats)
let secA = { start: 0, end: 8 };
let secB = { start: 16, end: 24 };

// Beat offset — shifts playback and exported bar values (in beats, 4 beats = 1 bar in 4/4)
let beatOffset = 0;

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
  noteData = null;

  // Default sections: A = bars 1–9, B = bars 17–25 (reasonable starting point)
  const nb = song.n_bars ?? 32;
  secA = { start: 1,          end: Math.min(9,  Math.floor(nb * 0.3)) };
  secB = { start: Math.min(17, Math.floor(nb * 0.55)),
           end:   Math.min(25, Math.floor(nb * 0.80)) };

  renderSongView();
  loadNoteData(slug);
}

/* ── Piano roll note data ────────────────────────────────── */
async function loadNoteData(slug) {
  try {
    const res = await fetch(`notes/${slug}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    noteData = await res.json();
  } catch (e) {
    console.warn("No note data for", slug, e.message);
    noteData = null;
  }
  drawCanvas();
}

function drawCanvas() {
  const canvas = document.getElementById("tl-canvas");
  if (!canvas) return;

  const bar = canvas.parentElement;
  const W   = bar.clientWidth;
  const H   = bar.clientHeight;
  if (W === 0 || H === 0) return;
  canvas.width  = W;
  canvas.height = H;

  const ctx = canvas.getContext("2d");
  const nb  = noteData?.n_bars ?? song?.n_bars ?? 32;

  // Background
  ctx.fillStyle = "#1a2030";
  ctx.fillRect(0, 0, W, H);

  // Notes
  if (noteData?.notes?.length) {
    const pLo    = noteData.pitch_lo ?? 0;
    const pHi    = noteData.pitch_hi ?? 127;
    const pRange = Math.max(pHi - pLo + 1, 1);
    const rowH   = Math.max(1.5, H / pRange);

    for (const [pitch, startBar, durBar, tidx] of noteData.notes) {
      const color = noteData.tracks?.[tidx]?.color ?? "#7c3aed";
      const x  = startBar / nb * W;
      const w  = Math.max(1.5, durBar / nb * W - 0.5);
      const yF = 1 - (pitch - pLo) / pRange;
      const y  = yF * (H - rowH);
      ctx.fillStyle = color + "bb";
      ctx.fillRect(x, y, w, rowH);
    }
  }

  // Beat grid (subtle, only when not too dense)
  if (nb <= 128) {
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth   = 0.5;
    for (let b = 0; b < nb; b++) {
      for (let beat = 1; beat < 4; beat++) {
        const x = (b + beat / 4) / nb * W;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }
    }
  }

  // Bar lines
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.lineWidth   = 0.75;
  for (let b = 1; b < nb; b++) {
    const x = b / nb * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }

  // 4-bar phrase lines (brighter)
  ctx.strokeStyle = "rgba(255,255,255,0.32)";
  ctx.lineWidth   = 1;
  for (let b = 0; b <= nb; b += 4) {
    const x = b / nb * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
}

/* ── Song view ───────────────────────────────────────────── */
function renderSongView() {
  if (!song) return;
  const main = document.getElementById("main");
  const nb   = song.n_bars ?? 32;
  const bpm  = song.bpm ?? 120;
  const insts = (song.instruments ?? []).slice(0, 5).join(", ");

  beatOffset = 0;   // reset offset when switching songs

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
          <canvas id="tl-canvas"></canvas>
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

      <div class="offset-row">
        <span class="offset-label">Beat offset</span>
        <button class="offset-btn" onclick="changeBeatOffset(-1)">−</button>
        <span class="offset-val" id="offset-val">0 beats</span>
        <button class="offset-btn" onclick="changeBeatOffset(+1)">+</button>
        <span class="offset-hint" id="offset-hint"></span>
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

  // Piano roll canvas — draw placeholder grid now; notes arrive async
  if (canvasRO) canvasRO.disconnect();
  canvasRO = new ResizeObserver(() => drawCanvas());
  canvasRO.observe(document.getElementById("tl-bar"));
  drawCanvas();
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

/* ── Beat offset ─────────────────────────────────────────── */
function changeBeatOffset(delta) {
  beatOffset = Math.max(-8, Math.min(8, beatOffset + delta));
  const el   = document.getElementById("offset-val");
  const hint = document.getElementById("offset-hint");
  if (el) el.textContent = `${beatOffset > 0 ? "+" : ""}${beatOffset} beat${Math.abs(beatOffset) !== 1 ? "s" : ""}`;
  if (hint) {
    const bpm     = song?.bpm ?? 120;
    const barFrac = beatOffset / 4;
    const secShift = beatOffset * (60 / bpm);
    hint.textContent = beatOffset === 0
      ? ""
      : `(${barFrac > 0 ? "+" : ""}${barFrac.toFixed(2)} bars · ${secShift > 0 ? "+" : ""}${secShift.toFixed(2)}s)`;
  }
}

/* ── Audio playback ──────────────────────────────────────── */
function barToSec(bar) {
  const bpm        = song?.bpm ?? 120;
  const offsetSec  = beatOffset * (60 / bpm);   // beat offset in seconds
  return bar * (60 / bpm) * 4 + offsetSec;
}

function playSection(which) {
  if (!audio || !song) return;
  if (!song.audio_url) {
    alert("No audio file available for this song yet.");
    return;
  }
  clearTimeout(playStopAt);

  const sec      = which === "a" ? secA : secB;
  const startSec = Math.max(0, barToSec(sec.start));
  const endSec   = Math.max(0, barToSec(sec.end));

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
  const offsetBars = beatOffset / 4;   // beat offset expressed in bars
  queue.push({
    slug:        song.slug,
    artist:      song.artist,
    title:       song.title,
    bpm:         song.bpm,
    midi:        song.midi_path ?? "",
    secA:        { start: secA.start + offsetBars, end: secA.end + offsetBars },
    secB:        { start: secB.start + offsetBars, end: secB.end + offsetBars },
    beatOffset,
    addedAt:     Date.now(),
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
        ${q.beatOffset ? `<span style="font-size:10px;color:var(--muted)">offset ${q.beatOffset > 0 ? "+" : ""}${q.beatOffset}b</span>` : ""}
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
