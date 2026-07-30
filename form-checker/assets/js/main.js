/* AI Form Checker — orchestrator.
 *
 * Wires: DOM ↔ pose detection ↔ rep detection ↔ feedback ↔ canvas overlay.
 * Runs entirely in the browser. No network I/O except:
 *   - MediaPipe WASM + pose model from Google's CDN (one-time, on init)
 *   - Optional Groq LLM call (only if user pasted a key)
 */

import { EXERCISES, getExercise } from "./exercises.js";
import { initPose, detectFromVideo, computeAngles, POSE_CONNECTIONS } from "./pose.js";
import { detectReps } from "./reps.js";
import { critique, validateGroqKey } from "./feedback.js";

// ── DOM shortcuts ─────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const dom = {
  uploader: $("uploader"), analysis: $("analysis"), results: $("results"), error: $("error"),
  exerciseSel: $("exercise"),
  drop: $("drop"), file: $("file"), analyze: $("analyze"), loaderMsg: $("loader-msg"),
  video: $("video"), overlay: $("overlay"),
  playPause: $("play-pause"), stopBtn: $("stop"), liveHud: $("live-hud"),
  summary: $("summary"), badge: $("coach-badge"),
  fixes: $("fixes"), fixesWrap: $("fixes-wrap"),
  strengths: $("strengths"), strengthsWrap: $("strengths-wrap"),
  repsTable: $("reps-table"), repCountBadge: $("rep-count-badge"),
  restart: $("restart"), errorMsg: $("error-msg"), errorRestart: $("error-restart"),
  settingsBtn: $("settings-btn"), settings: $("settings"),
  groqKey: $("groq-key"), groqModel: $("groq-model"),
  clearKey: $("clear-key"), testKey: $("test-key"),
  validateMsg: $("validate-msg"),
  headerCoachStatus: $("header-coach-status"),
  welcome: $("welcome"), welcomeSetup: $("welcome-setup"), welcomeSkip: $("welcome-skip"),
};

// ── state ────────────────────────────────────────────────────────────────
const state = {
  file: null,
  exercise: null,
  frames: [],           // rolling {t, angles} buffer, one per processed frame
  reps: [],
  rafId: null,
  usingVFC: false,      // whether we can use requestVideoFrameCallback
  lastProcessedTs: -1,  // monotonic ms guard for MediaPipe VIDEO mode
};

const STORAGE_KEYS = {
  groqKey: "form_checker.groq_key",
  groqModel: "form_checker.groq_model",
  welcomeDismissed: "form_checker.welcome_dismissed_v1",
};

// ── boot ─────────────────────────────────────────────────────────────────
async function boot() {
  populateExercises();
  wireUpload();
  wireControls();
  wireSettings();
  wireWelcomeBanner();
  restoreCoachSettings();
  updateHeaderCoachStatus();

  try {
    await initPose({ onStatus: (msg) => dom.loaderMsg.textContent = msg });
    dom.loaderMsg.textContent = "Pose model ready. Pick an exercise and load a video.";
    if (state.file) dom.analyze.disabled = false;
  } catch (e) {
    showError(`Failed to load pose model: ${e.message}. Check your internet connection.`);
  }
}

function populateExercises() {
  dom.exerciseSel.innerHTML = "";
  for (const key of Object.keys(EXERCISES)) {
    const ex = EXERCISES[key];
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = ex.name;
    opt.title = ex.description;
    dom.exerciseSel.appendChild(opt);
  }
}

// ── welcome banner (first-visit onboarding) ─────────────────────────────

function wireWelcomeBanner() {
  const dismissed = localStorage.getItem(STORAGE_KEYS.welcomeDismissed) === "1";
  const hasKey = !!localStorage.getItem(STORAGE_KEYS.groqKey);
  if (!dismissed && !hasKey) {
    dom.welcome.classList.remove("hidden");
  }
  dom.welcomeSetup.addEventListener("click", () => {
    dismissWelcome();
    dom.settings.showModal();
  });
  dom.welcomeSkip.addEventListener("click", dismissWelcome);
}

function dismissWelcome() {
  localStorage.setItem(STORAGE_KEYS.welcomeDismissed, "1");
  dom.welcome.classList.add("hidden");
}

// ── header status pill ──────────────────────────────────────────────────

function updateHeaderCoachStatus() {
  const key = localStorage.getItem(STORAGE_KEYS.groqKey);
  const el = dom.headerCoachStatus;
  el.classList.remove("good", "warn");
  if (key) {
    el.textContent = "coach · LLM";
    el.classList.add("good");
    el.title = `Groq key configured. Click to change.`;
  } else {
    el.textContent = "coach · heuristic";
    el.classList.add("warn");
    el.title = "No LLM configured. Click ⚙︎ coach to add a free Groq key.";
  }
  // Clicking the pill opens settings — same behavior as the button.
  if (!el.dataset.wired) {
    el.addEventListener("click", () => dom.settings.showModal());
    el.style.cursor = "pointer";
    el.dataset.wired = "1";
  }
}

// ── upload ───────────────────────────────────────────────────────────────
function wireUpload() {
  dom.drop.addEventListener("click", () => dom.file.click());
  dom.drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); dom.file.click(); }
  });
  ["dragenter", "dragover"].forEach(ev =>
    dom.drop.addEventListener(ev, (e) => { e.preventDefault(); dom.drop.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach(ev =>
    dom.drop.addEventListener(ev, (e) => { e.preventDefault(); dom.drop.classList.remove("dragover"); }));

  dom.drop.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) setFile(f);
  });
  dom.file.addEventListener("change", () => {
    const f = dom.file.files?.[0];
    if (f) setFile(f);
  });

  dom.analyze.addEventListener("click", startAnalysis);
}

function setFile(f) {
  state.file = f;
  dom.analyze.disabled = false;
  dom.drop.querySelector(".drop-inner").innerHTML = `
    <p><strong>${escapeHtml(f.name)}</strong></p>
    <p class="hint">${(f.size / 1024 / 1024).toFixed(1)} MB · click to change</p>`;
}

// ── analysis (live loop) ─────────────────────────────────────────────────

async function startAnalysis() {
  if (!state.file) return;

  state.exercise = getExercise(dom.exerciseSel.value);
  state.frames = [];
  state.reps = [];
  state.lastProcessedTs = -1;

  showSection("analysis");

  // Prepare video source
  const url = URL.createObjectURL(state.file);
  dom.video.src = url;
  dom.video.load();

  await once(dom.video, "loadedmetadata");
  // Match canvas to intrinsic video size for correct landmark projection.
  dom.overlay.width = dom.video.videoWidth;
  dom.overlay.height = dom.video.videoHeight;
  dom.video.currentTime = 0;

  await dom.video.play().catch(() => { /* autoplay policies can defer play */ });
  dom.playPause.textContent = "Pause";

  scheduleProcess();
}

function scheduleProcess() {
  // requestVideoFrameCallback lets us process exactly one call per decoded frame,
  // avoiding wasted work on high-refresh displays. Fallback to rAF where absent.
  if (typeof dom.video.requestVideoFrameCallback === "function") {
    state.usingVFC = true;
    dom.video.requestVideoFrameCallback(processVideoFrame);
  } else {
    state.usingVFC = false;
    state.rafId = requestAnimationFrame(processRAFFrame);
  }
}

function processVideoFrame(_now, _metadata) {
  processCurrentVideoFrame();
  if (!dom.video.paused && !dom.video.ended) {
    dom.video.requestVideoFrameCallback(processVideoFrame);
  }
}
function processRAFFrame() {
  processCurrentVideoFrame();
  if (!dom.video.paused && !dom.video.ended) {
    state.rafId = requestAnimationFrame(processRAFFrame);
  }
}

function processCurrentVideoFrame() {
  // MediaPipe VIDEO mode requires strictly monotonic timestamps in ms.
  // currentTime is in seconds and may repeat exactly when the tab is throttled.
  let tsMs = Math.round(dom.video.currentTime * 1000);
  if (tsMs <= state.lastProcessedTs) tsMs = state.lastProcessedTs + 1;
  state.lastProcessedTs = tsMs;

  let landmarks = null;
  try {
    landmarks = detectFromVideo(dom.video, tsMs);
  } catch (e) {
    console.warn("pose detect failed:", e);
    return;
  }

  const angles = landmarks ? computeAngles(landmarks) : null;
  state.frames.push({ t: dom.video.currentTime, landmarks, angles });

  drawOverlay(landmarks, angles);
  refreshLiveHud();

  if (dom.video.ended) finalize();
}

// ── drawing ──────────────────────────────────────────────────────────────

function drawOverlay(landmarks, angles) {
  const ctx = dom.overlay.getContext("2d");
  const w = dom.overlay.width, h = dom.overlay.height;
  ctx.clearRect(0, 0, w, h);

  if (landmarks) {
    // Skeleton edges
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = Math.max(2, w / 480);
    ctx.beginPath();
    for (const [a, b] of POSE_CONNECTIONS) {
      const pa = landmarks[a], pb = landmarks[b];
      if (!pa || !pb) continue;
      ctx.moveTo(pa.x * w, pa.y * h);
      ctx.lineTo(pb.x * w, pb.y * h);
    }
    ctx.stroke();

    // Joints
    ctx.fillStyle = "#4ade80";
    for (const p of landmarks) {
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, Math.max(3, w / 350), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // HUD panel — rep count + live angles
  drawHud(ctx, angles, w, h);
}

function drawHud(ctx, angles, w, h) {
  const panelW = Math.min(280, w * 0.35);
  const panelH = 20 + 26 + (state.exercise.trackedAngles.length * 22) + 12;

  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, panelW, panelH);

  ctx.textBaseline = "top";
  ctx.font = `${Math.max(11, w / 90)}px -apple-system, system-ui, sans-serif`;
  ctx.fillStyle = "#fff";
  ctx.fillText(state.exercise.name, 12, 8);

  ctx.font = `bold ${Math.max(14, w / 55)}px -apple-system, system-ui, sans-serif`;
  ctx.fillStyle = "#4ade80";
  ctx.fillText(`reps: ${state.reps.length}`, 12, 30);

  if (!angles) return;
  ctx.font = `${Math.max(11, w / 100)}px -apple-system, system-ui, sans-serif`;
  ctx.fillStyle = "#e6e9ef";
  let y = 62;
  for (const key of state.exercise.trackedAngles) {
    if (!(key in angles)) continue;
    ctx.fillText(`${key}: ${angles[key].toFixed(1)}`, 12, y);
    y += 22;
  }
}

function refreshLiveHud() {
  // Cheap update on every frame: recompute reps from the current buffer.
  // O(n) each call but n stays bounded by video length and this is well within
  // browser main-thread budget for typical <5-min clips.
  state.reps = detectReps(state.frames, state.exercise);
  const last = state.frames.at(-1);
  const kneeOrElbow = last?.angles?.[state.exercise.repSignal];
  dom.liveHud.textContent =
    `reps ${state.reps.length} · ` +
    (Number.isFinite(kneeOrElbow) ? `${state.exercise.repSignal} ${kneeOrElbow.toFixed(0)}°` : "no pose");
}

// ── controls ─────────────────────────────────────────────────────────────

function wireControls() {
  dom.playPause.addEventListener("click", () => {
    if (dom.video.paused) {
      dom.video.play(); dom.playPause.textContent = "Pause";
      scheduleProcess();  // resume the processing loop
    } else {
      dom.video.pause(); dom.playPause.textContent = "Play";
    }
  });
  dom.stopBtn.addEventListener("click", () => finalize());
  dom.restart.addEventListener("click", resetAll);
  dom.errorRestart.addEventListener("click", resetAll);
}

async function finalize() {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  dom.video.pause();

  state.reps = detectReps(state.frames, state.exercise);
  showSection("results");
  renderRepsTable(state.reps, state.exercise);

  const apiKey = localStorage.getItem(STORAGE_KEYS.groqKey) || null;
  const model = localStorage.getItem(STORAGE_KEYS.groqModel) || undefined;

  dom.summary.textContent = apiKey ? "Coach is reviewing…" : "Building feedback…";

  const fb = await critique(state.reps, state.exercise, { apiKey, model });
  renderFeedback(fb);
}

// ── render results ───────────────────────────────────────────────────────

function renderFeedback(fb) {
  dom.summary.textContent = fb.summary || "No feedback available.";
  dom.badge.innerHTML = fb.usedLLM
    ? `<span class="pill good">coach · LLM</span>`
    : `<span class="pill warn">coach · heuristic fallback</span>`;
  if (fb.llmError) {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = `LLM error: ${fb.llmError}`;
    dom.badge.appendChild(p);
  }
  toggleList(dom.fixes,     dom.fixesWrap,     fb.fixes);
  toggleList(dom.strengths, dom.strengthsWrap, fb.strengths);
}

function toggleList(list, wrap, items) {
  list.innerHTML = "";
  if (!items?.length) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    list.appendChild(li);
  }
}

function renderRepsTable(reps, exercise) {
  const table = dom.repsTable;
  table.innerHTML = "";
  dom.repCountBadge.textContent = `${reps.length} detected`;

  if (reps.length === 0) {
    table.innerHTML = "<tbody><tr><td class='muted'>No full reps detected. Try filming from the side with the full body in-frame.</td></tr></tbody>";
    return;
  }

  const angleKeys = Object.keys(reps[0].stats || {});
  const thead = document.createElement("thead");
  thead.innerHTML = `<tr>
    <th>#</th><th>start</th><th>bottom</th><th>end</th><th>duration</th>
    ${angleKeys.map(k => `<th>${k}<br/><span class="muted">min–max</span></th>`).join("")}
  </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const r of reps) {
    const cells = angleKeys.map(k => {
      const s = r.stats[k];
      return `<td>${s.min.toFixed(0)}–${s.max.toFixed(0)}</td>`;
    }).join("");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${r.index}</strong></td>
      <td>${r.startTime.toFixed(2)}s</td>
      <td>${r.bottomTime.toFixed(2)}s</td>
      <td>${r.endTime.toFixed(2)}s</td>
      <td>${r.duration.toFixed(2)}s</td>
      ${cells}`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

// ── settings drawer ──────────────────────────────────────────────────────

function wireSettings() {
  dom.settingsBtn.addEventListener("click", openSettings);

  dom.settings.addEventListener("close", () => {
    // dialog `returnValue` reflects the submit button's `value` attribute.
    if (dom.settings.returnValue === "save") {
      saveCoachSettings();
      updateHeaderCoachStatus();
    }
    clearValidateMsg();
  });

  dom.clearKey.addEventListener("click", (e) => {
    e.preventDefault();
    dom.groqKey.value = "";
    localStorage.removeItem(STORAGE_KEYS.groqKey);
    updateHeaderCoachStatus();
    dom.settings.close("clear");
  });

  dom.testKey.addEventListener("click", async (e) => {
    e.preventDefault();
    const key = dom.groqKey.value.trim();
    if (!key) return showValidateMsg("Paste a key first.", "warn");
    showValidateMsg("Testing…", "muted");
    try {
      const res = await validateGroqKey(key);
      // If Groq listed models we don't have in the picker, add them so users
      // aren't stuck with the three defaults.
      populateGroqModels(res.models);
      showValidateMsg(`✓ Key OK — ${res.modelCount} models available.`, "good");
    } catch (err) {
      showValidateMsg(`✗ ${err.message}`, "bad");
    }
  });
}

function openSettings() {
  dom.settings.showModal();
  clearValidateMsg();
}

function showValidateMsg(text, kind) {
  const el = dom.validateMsg;
  el.textContent = text;
  el.className = `validate ${kind}`;
  el.classList.remove("hidden");
}

function clearValidateMsg() {
  dom.validateMsg.textContent = "";
  dom.validateMsg.className = "validate hidden";
}

function populateGroqModels(ids) {
  if (!ids?.length) return;
  const currentSelection = dom.groqModel.value;
  const existingIds = new Set(Array.from(dom.groqModel.options).map(o => o.value));
  // Filter to chat-capable ids (heuristic: skip whisper/tts/guard/audio models).
  const chatLike = ids.filter(id =>
    !/whisper|tts|guard|audio|embed/i.test(id)
  );
  for (const id of chatLike) {
    if (existingIds.has(id)) continue;
    const opt = document.createElement("option");
    opt.value = id; opt.textContent = id;
    dom.groqModel.appendChild(opt);
  }
  // Restore selection if still present, else keep the default.
  if (Array.from(dom.groqModel.options).some(o => o.value === currentSelection)) {
    dom.groqModel.value = currentSelection;
  }
}

function restoreCoachSettings() {
  const key = localStorage.getItem(STORAGE_KEYS.groqKey);
  const model = localStorage.getItem(STORAGE_KEYS.groqModel);
  if (key) dom.groqKey.value = key;
  if (model) {
    // The stored model may not be in our static list; add it so <select> shows it.
    const existingIds = new Set(Array.from(dom.groqModel.options).map(o => o.value));
    if (!existingIds.has(model)) {
      const opt = document.createElement("option");
      opt.value = model; opt.textContent = model;
      dom.groqModel.appendChild(opt);
    }
    dom.groqModel.value = model;
  }
}

function saveCoachSettings() {
  const key = dom.groqKey.value.trim();
  if (key) localStorage.setItem(STORAGE_KEYS.groqKey, key);
  else localStorage.removeItem(STORAGE_KEYS.groqKey);
  localStorage.setItem(STORAGE_KEYS.groqModel, dom.groqModel.value);
}

// ── section switching ───────────────────────────────────────────────────

function showSection(name) {
  for (const id of ["uploader", "analysis", "results", "error"]) {
    document.getElementById(id).classList.toggle("hidden", id !== name);
  }
}

function showError(msg) {
  dom.errorMsg.textContent = msg;
  showSection("error");
}

function resetAll() {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.file = null;
  state.frames = [];
  state.reps = [];
  state.lastProcessedTs = -1;
  dom.file.value = "";
  dom.analyze.disabled = true;
  dom.drop.querySelector(".drop-inner").innerHTML = `
    <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">
      <path fill="currentColor" d="M12 3l4 4h-3v6h-2V7H8l4-4zm-7 14h14v2H5v-2z"/>
    </svg>
    <p><strong>Drop a video here</strong> or click to browse</p>
    <p class="hint">mp4 · mov · webm — pose runs locally, no upload</p>`;
  showSection("uploader");
}

// ── utils ───────────────────────────────────────────────────────────────

function once(el, event) {
  return new Promise(resolve => el.addEventListener(event, resolve, { once: true }));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

boot().catch(e => showError(`Boot failed: ${e.message}`));
