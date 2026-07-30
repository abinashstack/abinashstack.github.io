/* Exercise configs — mirror of python_backend/exercises.py.
 *
 * Each exercise defines:
 *   - repSignal   angle whose min = rep bottom
 *   - repBottom   signal threshold to count as "reached bottom"
 *   - repTop      signal threshold to count as "back at top"
 *   - trackedAngles  which angles to summarize in the rep table
 *   - heuristics  deterministic form cues (see feedback.js)
 *
 * Adding a new exercise = one entry here. No other code changes.
 */

export const EXERCISES = {
  squat: {
    key: "squat",
    name: "Barbell / Bodyweight Squat",
    repSignal: "knee",
    repBottom: 110,
    repTop: 160,
    description: (
      "Standing squat viewed from the side. Good form: neutral spine, " +
      "hips descend below knee crease (parallel or deeper), knees track " +
      "over toes, torso stays as upright as anatomy allows."
    ),
    trackedAngles: ["knee", "hip", "torso_lean", "hip_below_knee"],
    heuristics: [
      ["knee", "min<", 100, "achieves parallel or below (knee bent to {min}°)"],
      ["knee", "min_in", [100, 130], "borderline depth — knee only bent to {min}°"],
      ["knee", "min_in", [130, 180], "insufficient depth — knee only bent to {min}°"],
      ["torso_lean", "max>", 55, "excessive forward lean ({max}°); brace core, sit back"],
      ["hip_below_knee", "min<", 0, "hip crease drops below knee — good depth"],
    ],
  },

  pushup: {
    key: "pushup",
    name: "Pushup",
    repSignal: "elbow",
    repBottom: 100,
    repTop: 160,
    description: (
      "Pushup viewed from the side. Good form: rigid plank from shoulder " +
      "to ankle (body_line near 180°), elbows tuck ~45° from torso, chest " +
      "descends to near-ground, no hip sag or pike."
    ),
    trackedAngles: ["elbow", "body_line", "hip"],
    heuristics: [
      ["elbow", "min<", 95, "full range of motion (elbow bent to {min}°)"],
      ["elbow", "min_in", [95, 120], "borderline pushup depth — elbow to {min}°"],
      ["elbow", "min_in", [120, 180], "shallow pushup — elbow only bent to {min}°"],
      ["body_line", "min<", 160, "hips sagging or piking (body_line dips to {min}°)"],
    ],
  },

  deadlift: {
    key: "deadlift",
    name: "Deadlift",
    repSignal: "hip",
    repBottom: 100,
    repTop: 170,
    description: (
      "Deadlift viewed from the side. Good form: neutral spine held " +
      "throughout, hip hinge (not squat), bar path close to body, " +
      "shoulders slightly ahead of bar at setup, full lockout at top."
    ),
    trackedAngles: ["hip", "knee", "torso_lean"],
    heuristics: [
      ["hip", "max>", 165, "reaches full hip lockout at top ({max}°)"],
      ["hip", "max_in", [140, 165], "incomplete lockout — hip only extends to {max}°"],
      ["torso_lean", "max>", 75, "torso very horizontal at setup ({max}°) — normal for conventional pull"],
    ],
  },
};

export function getExercise(key) {
  const ex = EXERCISES[key];
  if (!ex) throw new Error(`unknown exercise: ${key}`);
  return ex;
}
