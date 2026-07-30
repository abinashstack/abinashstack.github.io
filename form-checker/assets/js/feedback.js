/* Feedback generation.
 *
 * Two paths:
 *   1. Deterministic — heuristic cues per rep. Free, offline, always available.
 *   2. LLM (Groq)    — optional: user pastes key in ⚙︎ coach settings. Key
 *                      stays in localStorage; requests go from the browser
 *                      directly to api.groq.com. No proxy server on our side.
 */

const PRAISE_MARKERS = [
  "achieves parallel",
  "parallel or below",
  "full range",
  "full lockout",
  "reaches full",
  "good depth",
  "— normal",
];

function isPraise(msg) {
  const lower = msg.toLowerCase();
  return PRAISE_MARKERS.some(m => lower.includes(m));
}

// ── deterministic cues ────────────────────────────────────────────────────

export function deterministicCues(reps, exercise) {
  const out = [];
  for (const rep of reps) {
    for (const [angle, op, threshold, template] of exercise.heuristics) {
      const s = rep.stats[angle];
      if (!s) continue;
      let hit = false;
      if (op === "min<") hit = s.min < threshold;
      else if (op === "max>") hit = s.max > threshold;
      else if (op === "min_in") { const [lo, hi] = threshold; hit = s.min >= lo && s.min < hi; }
      else if (op === "max_in") { const [lo, hi] = threshold; hit = s.max >= lo && s.max < hi; }
      else if (op === "range<") hit = (s.max - s.min) < threshold;
      else if (op === "range>") hit = (s.max - s.min) > threshold;
      if (hit) {
        const msg = template
          .replace("{min}", Math.round(s.min))
          .replace("{max}", Math.round(s.max))
          .replace("{mean}", Math.round(s.mean));
        out.push({ repIndex: rep.index, msg });
      }
    }
  }
  return out;
}

/** Build a Feedback purely from deterministic cues. */
export function heuristicFeedback(reps, exercise, reason, extras = {}) {
  if (!reps.length) {
    return {
      summary: (
        "No full reps detected. Film from the side with the entire body in " +
        "the frame, and complete at least 2–3 full-range reps."
      ),
      perRep: [], strengths: [], fixes: [],
      usedLLM: false, llmError: null,
      ...extras,
    };
  }

  const cues = deterministicCues(reps, exercise);
  const perRep = [], strengths = [], fixes = [];
  const seenS = new Set(), seenF = new Set();

  for (const { repIndex, msg } of cues) {
    perRep.push(`rep ${repIndex}: ${msg}`);
    if (isPraise(msg)) {
      if (!seenS.has(msg)) { strengths.push(msg); seenS.add(msg); }
    } else {
      if (!seenF.has(msg)) { fixes.push(msg); seenF.add(msg); }
    }
  }

  let summary = `${reason} Detected ${reps.length} reps.`;
  if (fixes.length) summary += ` Deterministic form cues flagged ${fixes.length} issue(s).`;
  return { summary, perRep, strengths, fixes, usedLLM: false, ...extras };
}

// ── prompt ────────────────────────────────────────────────────────────────

function buildPrompt(reps, exercise, cues) {
  const repLines = reps.map(r => {
    const stats = Object.entries(r.stats)
      .map(([k, v]) => `${k}(min=${v.min.toFixed(0)}, max=${v.max.toFixed(0)})`)
      .join(", ");
    return `  rep ${r.index} (${r.duration.toFixed(1)}s): ${stats}`;
  }).join("\n");

  const cueLines = cues.length
    ? cues.map(c => `  - rep ${c.repIndex}: ${c.msg}`).join("\n")
    : "  (none fired)";

  return `You are a strength & conditioning coach analyzing exercise form from
pose-estimation data. Be concise, specific, and actionable. Reference actual
angle numbers when giving feedback.

Exercise: ${exercise.name}
Context: ${exercise.description}

Angles are in degrees; joint angles are the interior angle at that joint (180°
= straight limb, smaller = more bent). torso_lean is degrees from vertical
(0 = perfectly upright). body_line is shoulder-hip-ankle alignment (180 =
plank). hip_below_knee is a vertical-position signal (negative = hip is below
knee).

Per-rep angle stats:
${repLines}

Deterministic form cues that fired:
${cueLines}

Respond as strict JSON:
{
  "summary": "2-3 sentence overall assessment",
  "per_rep": ["rep 1: ...", "rep 2: ...", ...],
  "strengths": ["...", "..."],
  "fixes": ["most important fix first", "second priority", "..."]
}
Return ONLY the JSON — no markdown fences, no commentary.`;
}

// ── Groq API ──────────────────────────────────────────────────────────────

async function callGroq(prompt, { apiKey, model }) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Map common statuses to user-actionable messages.
    if (res.status === 401) throw new Error("Groq rejected the API key (401). Re-check ⚙︎ coach.");
    if (res.status === 403) throw new Error("Key forbidden (403) — may be revoked or lack this model.");
    if (res.status === 404) throw new Error(`Model not found (404): try a different model in ⚙︎ coach.`);
    if (res.status === 429) throw new Error("Groq rate limit hit (429). Wait a minute or try a smaller model.");
    if (res.status >= 500)  throw new Error(`Groq server error ${res.status}. Try again shortly.`);
    throw new Error(`Groq API ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

/**
 * Verify a key/model pair without spending completion tokens.
 * Uses GET /models — cheapest authenticated call. Returns available model ids
 * so the UI can offer them in the picker.
 */
export async function validateGroqKey(apiKey) {
  if (!apiKey) throw new Error("no key provided");
  const res = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 401) throw new Error("Groq rejected this key (401)");
  if (res.status === 403) throw new Error("Key forbidden (403)");
  if (!res.ok) throw new Error(`Groq /models returned ${res.status}`);
  const data = await res.json();
  const models = (data.data || []).map(m => m.id).sort();
  return { ok: true, modelCount: models.length, models };
}

/**
 * Full critique pipeline. Always returns a populated Feedback object.
 * When no key is present or the call fails, falls back to heuristics.
 */
export async function critique(reps, exercise, { apiKey, model }) {
  if (!reps.length) {
    return heuristicFeedback(reps, exercise, "No reps detected.");
  }
  if (!apiKey) {
    return heuristicFeedback(reps, exercise,
      "Coach LLM not configured — click ⚙︎ coach to add a Groq key.");
  }

  const cues = deterministicCues(reps, exercise);
  const prompt = buildPrompt(reps, exercise, cues);
  let raw;
  try {
    raw = await callGroq(prompt, { apiKey, model: model || "llama-3.3-70b-versatile" });
  } catch (e) {
    return heuristicFeedback(reps, exercise,
      "Coach LLM call failed; showing deterministic cues.",
      { llmError: String(e.message || e) });
  }

  let data;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    data = JSON.parse(match ? match[0] : raw);
  } catch (e) {
    return heuristicFeedback(reps, exercise,
      "Coach returned malformed JSON; showing deterministic cues.",
      { llmError: `JSON parse: ${e.message}` });
  }

  return {
    summary: (data.summary || "").trim() || "(no summary)",
    perRep: (data.per_rep || []).map(String),
    strengths: (data.strengths || []).map(String),
    fixes: (data.fixes || []).map(String),
    usedLLM: true,
    llmError: null,
  };
}
