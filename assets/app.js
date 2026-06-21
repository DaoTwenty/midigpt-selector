/* ── State ────────────────────────────────────────────────── */
let SONGS      = [];
let song       = null;
let queue      = [];
let audio      = null;
let noteData   = null;
let canvasRO   = null;
let markers    = [];   // sorted bar positions of internal section boundaries
let beatOffset = 0;
let drag       = null; // {markerIdx, rect, nb}
let playStopAt = null;

const SEC_COLORS = [
  { bg: "rgba(59,130,246,.18)",  border: "#3b82f6" },
  { bg: "rgba(34,197,94,.18)",   border: "#22c55e" },
  { bg: "rgba(251,191,36,.18)",  border: "#fbbf24" },
  { bg: "rgba(249,115,22,.18)",  border: "#f97316" },
  { bg: "rgba(168,85,247,.18)",  border: "#a855f7" },
  { bg: "rgba(236,72,153,.18)",  border: "#ec4899" },
];

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
  document.getElementById("search").addEventListener("input", e =>
    renderSongList(e.target.value.toLowerCase(),
                   document.getElementById("genre-filter").value));
  document.getElementById("genre-filter").addEventListener("change", e =>
    renderSongList(document.getElementById("search").value.toLowerCase(), e.target.value));

  // Global drag handlers — added once to avoid stacking on song switches
  document.addEventListener("mousemove", e => {
    if (!drag) return;
    const nb  = drag.nb;
    const pct = Math.max(0, Math.min(1, (e.clientX - drag.rect.left) / drag.rect.width));
    let b = Math.round(pct * nb);
    const prev = drag.markerIdx > 0 ? markers[drag.markerIdx - 1] : 0;
    const next = drag.markerIdx < markers.length - 1 ? markers[drag.markerIdx + 1] : nb;
    b = Math.max(prev + 2, Math.min(next - 2, b));
    markers[drag.markerIdx] = b;
    updateTimeline();
  });
  document.addEventListener("mouseup", () => {
    if (!drag) return;
    drag = null;
    document.body.style.cursor = "";
  });

  buildGenreFilter();
  renderSongList("", "");
  renderWelcome();
  renderQueue();
});

/* ── Sidebar ─────────────────────────────────────────────── */
function buildGenreFilter() {
  const genres = new Set();
  SONGS.forEach(s => (s.style || "").split(",").forEach(g => {
    const t = g.trim(); if (t) genres.add(t);
  }));
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
    const bpm = s.bpm ? Math.round(s.bpm) + " BPM" : "";
    const trk = s.num_tracks ? s.num_tracks + " trk" : "";
    const act = s.slug === song?.slug ? " active" : "";
    return `<li class="song-item${act}" data-slug="${s.slug}"
                onclick="selectSong('${s.slug}')">
      <div class="si-title">${s.artist} — ${s.title}</div>
      <div class="si-meta">${[bpm, trk, s.style?.split(",")[0]].filter(Boolean).join(" · ")}</div>
    </li>`;
  }).join("") ||
    `<li style="padding:20px 14px;color:var(--muted);font-size:13px">No songs match</li>`;
}

/* ── Song selection ──────────────────────────────────────── */
function selectSong(slug) {
  song = SONGS.find(s => s.slug === slug);
  if (!song) return;

  document.querySelectorAll(".song-item").forEach(el =>
    el.classList.toggle("active", el.dataset.slug === slug));

  stopAudio();
  noteData   = null;
  beatOffset = 0;

  // Default: 4 equal sections
  const nb = song.n_bars ?? 32;
  const q  = Math.round(nb / 4);
  markers = [q, q * 2, q * 3].filter(b => b > 0 && b < nb);

  renderSongView();
  loadNoteData(slug);
}

/* ── Sections ────────────────────────────────────────────── */
function getSections() {
  const nb  = song?.n_bars ?? 32;
  const pts = [0, ...markers, nb];
  return pts.slice(0, -1).map((s, i) => ({ start: s, end: pts[i + 1] }));
}

function addMarkerAt(bar) {
  const nb = song?.n_bars ?? 32;
  const b  = Math.max(1, Math.min(bar, nb - 1));
  if (markers.some(m => Math.abs(m - b) < 2)) return;
  markers = [...markers, b].sort((a, c) => a - c);
  updateTimeline();
}

function removeMarker(idx) {
  markers.splice(idx, 1);
  updateTimeline();
}

/* ── Piano roll ──────────────────────────────────────────── */
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
  const barEl = canvas.parentElement;
  const W = barEl.clientWidth, H = barEl.clientHeight;
  if (!W || !H) return;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");

  // Always use song.n_bars so notes align with the playhead and ruler
  const nb = song?.n_bars ?? noteData?.n_bars ?? 32;

  ctx.fillStyle = "#1a2030";
  ctx.fillRect(0, 0, W, H);

  if (noteData?.notes?.length) {
    const pLo = noteData.pitch_lo ?? 0, pHi = noteData.pitch_hi ?? 127;
    const pRange = Math.max(pHi - pLo + 1, 1);
    const rowH   = Math.max(1.5, H / pRange);
    for (const [pitch, startBar, durBar, tidx] of noteData.notes) {
      const color = noteData.tracks?.[tidx]?.color ?? "#7c3aed";
      const x = startBar / nb * W;
      const w = Math.max(1.5, durBar / nb * W - 0.5);
      const y = (1 - (pitch - pLo) / pRange) * (H - rowH);
      ctx.fillStyle = color + "bb";
      ctx.fillRect(x, y, w, rowH);
    }
  }

  if (nb <= 128) {
    ctx.strokeStyle = "rgba(255,255,255,0.05)"; ctx.lineWidth = 0.5;
    for (let b = 0; b < nb; b++)
      for (let beat = 1; beat < 4; beat++) {
        const x = (b + beat / 4) / nb * W;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }
  }

  ctx.strokeStyle = "rgba(255,255,255,0.14)"; ctx.lineWidth = 0.75;
  for (let b = 1; b < nb; b++) {
    const x = b / nb * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }

  ctx.strokeStyle = "rgba(255,255,255,0.32)"; ctx.lineWidth = 1;
  for (let b = 0; b <= nb; b += 4) {
    const x = b / nb * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
}

/* ── Song view ───────────────────────────────────────────── */
function renderSongView() {
  if (!song) return;
  const main  = document.getElementById("main");
  const nb    = song.n_bars ?? 32;
  const bpm   = song.bpm ?? 120;
  const insts = (song.instruments ?? []).slice(0, 5).join(", ");

  main.innerHTML = `
    <div class="song-header">
      <h1>${song.artist} — ${song.title}</h1>
      <div class="sub">
        <span>♩ ${Math.round(bpm)} BPM</span>
        <span>≈ ${nb} bars</span>
        <span>${song.num_tracks ?? "?"} tracks</span>
        <span>${(song.style || "").split(",")[0]}</span>
        <span style="color:var(--muted)">${insts}</span>
      </div>
    </div>

    <div class="audio-card">
      <h3>Timeline — double-click to add boundary · drag to move · × to remove</h3>
      <audio id="audio-el" src="${song.audio_url ?? ""}"></audio>
      <div class="timeline-wrap">
        <div class="tl-bar" id="tl-bar">
          <canvas id="tl-canvas"></canvas>
          <div id="tl-sections" aria-hidden="true"></div>
          <div id="tl-markers"  aria-hidden="true"></div>
          <div class="tl-playhead" id="tl-playhead" style="left:0"></div>
        </div>
        <div class="tl-ruler" id="tl-ruler"></div>
      </div>

      <div id="sections-list" class="sections-list"></div>

      <div class="offset-row">
        <span class="offset-label">Beat offset</span>
        <button class="offset-btn" onclick="changeBeatOffset(-1)">−</button>
        <span class="offset-val" id="offset-val">0 beats</span>
        <button class="offset-btn" onclick="changeBeatOffset(+1)">+</button>
        <span class="offset-hint" id="offset-hint"></span>
      </div>

      <button class="btn-add" id="btn-add" onclick="addToQueue()">
        + Add sections to queue
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
  for (let b = 0; b <= nBars; b += step)
    html += `<span class="tl-tick" style="left:${(b / nBars * 100).toFixed(2)}%">${b}</span>`;
  ruler.innerHTML = html;
}

/* ── Timeline update ─────────────────────────────────────── */
function updateTimeline() {
  if (!song) return;
  const nb       = song.n_bars ?? 32;
  const bpm      = song.bpm ?? 120;
  const sections = getSections();
  const b2pct    = b => (b / nb * 100).toFixed(3) + "%";

  // Section colour blocks
  const secEl = document.getElementById("tl-sections");
  if (secEl) {
    secEl.innerHTML = sections.map((sec, i) => {
      const col = SEC_COLORS[i % SEC_COLORS.length];
      return `<div class="tl-section" style="
          left:${b2pct(sec.start)};
          width:${b2pct(sec.end - sec.start)};
          background:${col.bg};
          border-left:2px solid ${col.border};
          border-right:2px solid ${col.border}">
        <span class="tl-sec-label" style="color:${col.border}">${i + 1}</span>
      </div>`;
    }).join("");
  }

  // Marker handles (boundary lines)
  const mrkEl = document.getElementById("tl-markers");
  if (mrkEl) {
    mrkEl.innerHTML = markers.map((b, i) =>
      `<div class="tl-marker" data-idx="${i}" style="left:${b2pct(b)}">
        <div class="tl-marker-line"></div>
        <button class="tl-marker-del" onclick="removeMarker(${i})" title="Remove">×</button>
      </div>`
    ).join("");

    mrkEl.querySelectorAll(".tl-marker").forEach(el => {
      el.addEventListener("mousedown", e => {
        if (e.target.classList.contains("tl-marker-del")) return;
        e.stopPropagation();
        e.preventDefault();
        const bar = document.getElementById("tl-bar");
        drag = {
          markerIdx: parseInt(el.dataset.idx),
          rect: bar.getBoundingClientRect(),
          nb,
        };
        document.body.style.cursor = "col-resize";
      });
    });
  }

  // Section chips below timeline
  const listEl = document.getElementById("sections-list");
  if (listEl) {
    listEl.innerHTML = sections.map((sec, i) => {
      const col    = SEC_COLORS[i % SEC_COLORS.length];
      const nBars  = sec.end - sec.start;
      const durSec = (nBars * 60 / bpm * 4).toFixed(1);
      return `<div class="section-chip" style="border-color:${col.border}55"
                   onclick="playBars(${sec.start},${sec.end})">
        <div class="sc-label" style="color:${col.border}">§${i + 1}</div>
        <div class="sc-range">${sec.start} → ${sec.end}</div>
        <div class="sc-dur">${nBars} bars · ${durSec}s ▶</div>
      </div>`;
    }).join("");
  }
}

/* ── Drag / click ────────────────────────────────────────── */
function initDrag() {
  const bar = document.getElementById("tl-bar");
  if (!bar) return;

  bar.addEventListener("dblclick", e => {
    if (e.target.closest(".tl-marker")) return;
    if (!song) return;
    const nb   = song.n_bars ?? 32;
    const rect = bar.getBoundingClientRect();
    const b    = Math.round((e.clientX - rect.left) / rect.width * nb);
    addMarkerAt(b);
  });

  bar.addEventListener("click", e => {
    if (e.target.closest(".tl-marker")) return;
    if (!audio || !song) return;
    const nb   = song.n_bars ?? 32;
    const bpm  = song.bpm ?? 120;
    const rect = bar.getBoundingClientRect();
    const pct  = (e.clientX - rect.left) / rect.width;
    audio.currentTime = pct * nb * (60 / bpm) * 4;
    audio.play().catch(() => {});
  });
}

/* ── Playhead ────────────────────────────────────────────── */
function onTimeUpdate() {
  if (!audio || !song) return;
  const nb       = song.n_bars ?? 32;
  const bpm      = song.bpm ?? 120;
  const totalSec = nb * (60 / bpm) * 4;
  const pct      = (audio.currentTime / totalSec * 100).toFixed(2);
  const ph = document.getElementById("tl-playhead");
  if (ph) ph.style.left = pct + "%";
}

/* ── Beat offset ─────────────────────────────────────────── */
function changeBeatOffset(delta) {
  beatOffset = Math.max(-8, Math.min(8, beatOffset + delta));
  const el   = document.getElementById("offset-val");
  const hint = document.getElementById("offset-hint");
  if (el) el.textContent =
    `${beatOffset > 0 ? "+" : ""}${beatOffset} beat${Math.abs(beatOffset) !== 1 ? "s" : ""}`;
  if (hint) {
    const bpm     = song?.bpm ?? 120;
    const barFrac = beatOffset / 4;
    const secShift = beatOffset * (60 / bpm);
    hint.textContent = beatOffset === 0 ? "" :
      `(${barFrac > 0 ? "+" : ""}${barFrac.toFixed(2)} bars · ${secShift > 0 ? "+" : ""}${secShift.toFixed(2)}s)`;
  }
}

/* ── Audio playback ──────────────────────────────────────── */
function barToSec(bar) {
  const bpm = song?.bpm ?? 120;
  return bar * (60 / bpm) * 4 + beatOffset * (60 / bpm);
}

function playBars(startBar, endBar) {
  if (!audio || !song) return;
  if (!song.audio_url) { alert("No audio file available for this song yet."); return; }
  clearTimeout(playStopAt);
  const startSec = Math.max(0, barToSec(startBar));
  const endSec   = Math.max(0, barToSec(endBar));
  audio.currentTime = startSec;
  audio.play().catch(err => console.warn("Play failed:", err));
  playStopAt = setTimeout(() => audio.pause(), (endSec - startSec) * 1000);
}

function stopAudio() {
  clearTimeout(playStopAt);
  if (audio) audio.pause();
}

/* ── Queue ───────────────────────────────────────────────── */
function addToQueue() {
  if (!song) return;
  const offsetBars = beatOffset / 4;
  const sections   = getSections().map(s => [
    Math.round(s.start + offsetBars),
    Math.round(s.end   + offsetBars),
  ]);
  // Replace if same slug already in queue, else append
  const existing = queue.findIndex(q => q.slug === song.slug);
  const entry = {
    slug:       song.slug,
    artist:     song.artist,
    title:      song.title,
    bpm:        song.bpm,
    midi:       song.midi_path ?? "",
    sections,
    beatOffset,
    addedAt:    Date.now(),
  };
  if (existing >= 0) queue[existing] = entry;
  else queue.push(entry);
  renderQueue();
}

function removeFromQueue(idx) {
  queue.splice(idx, 1);
  renderQueue();
}

function clearQueue() {
  if (!queue.length) return;
  if (!confirm("Clear all annotated songs?")) return;
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
    list.innerHTML = `<div class="queue-empty">No songs annotated yet.<br>Mark section boundaries<br>and click "Add sections to queue".</div>`;
    return;
  }
  list.innerHTML = queue.map((q, i) => `
    <div class="queue-item">
      <button class="qi-remove" onclick="removeFromQueue(${i})">✕</button>
      <div class="qi-title">${q.artist} — ${q.title}</div>
      <div class="qi-range">
        <span>${q.sections.length} sections</span>
        ${q.beatOffset ? `<span style="font-size:10px;color:var(--muted)">offset ${q.beatOffset > 0 ? "+" : ""}${q.beatOffset}b</span>` : ""}
        <span style="font-size:10px;color:var(--muted)">${q.sections.map(s => s.join("→")).join(", ")}</span>
      </div>
    </div>`).join("");
}

function exportQueue() {
  if (!queue.length) return;
  const payload = {
    _note:   "Generated by midigpt-selector. Annotated section boundaries for random pair sampling.",
    catalog: queue.map(q => ({
      dataset:    "gigamidi",
      slug:       q.slug,
      midi:       q.midi,
      bpm:        q.bpm,
      beatOffset: q.beatOffset,
      sections:   q.sections,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), { href: url, download: "section_catalog.json" });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function renderWelcome() {
  document.getElementById("main").innerHTML = `
    <div class="welcome">
      <div class="icon">🎛️</div>
      <h2>MIDI-GPT Section Annotator</h2>
      <p>Pick a song, then <strong>double-click</strong> the timeline to add section boundaries.
         Drag boundaries to adjust, click a section chip to preview.
         Add each song's annotations to the queue and export the catalog.</p>
    </div>`;
}
