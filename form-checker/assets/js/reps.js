/* Rep detection — state machine on smoothed angle signal.
 *
 * Mirrors python_backend/reps.py. Reads a rolling buffer of {t, angles} frames
 * and produces committed reps as they complete. The primary signal for each
 * exercise is `exercise.repSignal` (e.g. "knee" for squat) and its trough marks
 * the bottom of a rep.
 */

/** Rolling moving-average smoothing. */
function smooth(values, window = 5) {
  if (window < 2 || values.length < window) return values.slice();
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0, count = 0;
    const lo = Math.max(0, i - Math.floor(window / 2));
    const hi = Math.min(values.length - 1, i + Math.floor(window / 2));
    for (let j = lo; j <= hi; j++) { sum += values[j]; count++; }
    out[i] = sum / count;
  }
  return out;
}

/**
 * Detect completed reps from a flat frame buffer.
 * @param frames  Array of {t, angles} objects.
 * @param exercise  Exercise config.
 * @returns Array of Rep objects.
 */
export function detectReps(frames, exercise) {
  if (!frames.length) return [];

  const key = exercise.repSignal;
  const valid = frames.filter(f => f.angles && key in f.angles);
  if (valid.length < 10) return [];

  const signal = smooth(valid.map(f => f.angles[key]));

  const reps = [];
  let state = "TOP";
  let startI = null;
  let bottomI = null;
  let bottomVal = Infinity;

  for (let i = 0; i < signal.length; i++) {
    const v = signal[i];
    if (state === "TOP") {
      if (v < exercise.repTop - 5) {
        state = "DESCENDING";
        startI = Math.max(0, i - 1);
        bottomVal = v;
        bottomI = i;
      }
    } else if (state === "DESCENDING") {
      if (v < bottomVal) { bottomVal = v; bottomI = i; }
      if (bottomVal < exercise.repBottom) state = "BOTTOM";
    } else if (state === "BOTTOM") {
      if (v < bottomVal) { bottomVal = v; bottomI = i; }
      if (v > bottomVal + 5) state = "ASCENDING";
    } else if (state === "ASCENDING") {
      if (v > exercise.repTop - 5) {
        reps.push(summarize(reps.length + 1, valid, startI, bottomI, i, exercise.trackedAngles));
        state = "TOP";
        startI = null; bottomI = null; bottomVal = Infinity;
      }
    }
  }
  return reps;
}

function summarize(idx, valid, startI, bottomI, endI, tracked) {
  const slice = valid.slice(startI, endI + 1);
  const stats = {};
  for (const key of tracked) {
    const vs = slice.map(f => f.angles?.[key]).filter(x => Number.isFinite(x));
    if (!vs.length) continue;
    let min = Infinity, max = -Infinity, sum = 0;
    for (const v of vs) { if (v < min) min = v; if (v > max) max = v; sum += v; }
    stats[key] = { min, max, mean: sum / vs.length };
  }
  return {
    index: idx,
    startTime: valid[startI].t,
    bottomTime: valid[bottomI].t,
    endTime: valid[endI].t,
    duration: valid[endI].t - valid[startI].t,
    stats,
  };
}
