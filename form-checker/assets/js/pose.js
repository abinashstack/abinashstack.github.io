/* Client-side pose extraction + angle computation.
 *
 * Uses MediaPipe Tasks JS PoseLandmarker (WASM + WebGPU accelerated).
 * Everything below runs in the browser — no server, no upload.
 */

import {
  PoseLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

// MediaPipe canonical 33-point body landmark indices (subset we reference).
export const LM = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13,    R_ELBOW: 14,
  L_WRIST: 15,    R_WRIST: 16,
  L_HIP: 23,      R_HIP: 24,
  L_KNEE: 25,     R_KNEE: 26,
  L_ANKLE: 27,    R_ANKLE: 28,
  L_HEEL: 29,     R_HEEL: 30,
  L_FOOT: 31,     R_FOOT: 32,
};

// 35 skeleton edges. MediaPipe's canonical POSE_CONNECTIONS, hardcoded so we
// don't depend on the (undocumented) internal export from the JS bundle.
export const POSE_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,7],[0,4],[4,5],[5,6],[6,8],[9,10],
  [11,12],[11,23],[12,24],[23,24],
  [11,13],[13,15],[15,17],[15,19],[15,21],[17,19],
  [12,14],[14,16],[16,18],[16,20],[16,22],[18,20],
  [23,25],[25,27],[27,29],[27,31],[29,31],
  [24,26],[26,28],[28,30],[28,32],[30,32],
];

const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/" +
  "pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";

// ── singleton landmarker ─────────────────────────────────────────────────

let _landmarker = null;
let _initPromise = null;

/** Lazy-init: model download + WASM setup happen exactly once per page load. */
export async function initPose({ onStatus } = {}) {
  if (_landmarker) return _landmarker;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    onStatus?.("Loading WASM runtime…");
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);

    onStatus?.("Downloading pose model (~5.8 MB)…");
    _landmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        // GPU delegate falls back to CPU automatically when WebGPU is unavailable.
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    onStatus?.("Pose model ready");
    return _landmarker;
  })();

  return _initPromise;
}

/**
 * Detect a single pose from a video element at the given timestamp.
 * Returns null if no pose is found in the frame.
 */
export function detectFromVideo(video, timestampMs) {
  if (!_landmarker) throw new Error("pose landmarker not initialized");
  const result = _landmarker.detectForVideo(video, timestampMs);
  if (!result.landmarks || result.landmarks.length === 0) return null;
  return result.landmarks[0];  // array of 33 { x, y, z, visibility }
}

// ── angle math ────────────────────────────────────────────────────────────

/** Interior angle at vertex `b` (in degrees) formed by segments b→a and b→c. */
function angleAt(a, b, c) {
  const bax = a.x - b.x, bay = a.y - b.y;
  const bcx = c.x - b.x, bcy = c.y - b.y;
  const dot = bax * bcx + bay * bcy;
  const magBA = Math.hypot(bax, bay);
  const magBC = Math.hypot(bcx, bcy);
  const cos = dot / (magBA * magBC + 1e-9);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/** Angle of vector (top→bottom) from vertical (0° = perfectly vertical). */
function verticalAngle(top, bottom) {
  const vx = top.x - bottom.x, vy = top.y - bottom.y;
  // Image y grows downward; vertical up = (0, -1).
  const cos = -vy / (Math.hypot(vx, vy) + 1e-9);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/**
 * Compute all tracked angles from a 33-landmark array.
 * Returns a flat map used by rep detection and feedback heuristics.
 */
export function computeAngles(p) {
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  const kneeL = angleAt(p[LM.L_HIP], p[LM.L_KNEE], p[LM.L_ANKLE]);
  const kneeR = angleAt(p[LM.R_HIP], p[LM.R_KNEE], p[LM.R_ANKLE]);
  const hipL  = angleAt(p[LM.L_SHOULDER], p[LM.L_HIP], p[LM.L_KNEE]);
  const hipR  = angleAt(p[LM.R_SHOULDER], p[LM.R_HIP], p[LM.R_KNEE]);
  const elbowL = angleAt(p[LM.L_SHOULDER], p[LM.L_ELBOW], p[LM.L_WRIST]);
  const elbowR = angleAt(p[LM.R_SHOULDER], p[LM.R_ELBOW], p[LM.R_WRIST]);

  const shoulderMid = midpoint(p[LM.L_SHOULDER], p[LM.R_SHOULDER]);
  const hipMid      = midpoint(p[LM.L_HIP],      p[LM.R_HIP]);
  const ankleMid    = midpoint(p[LM.L_ANKLE],    p[LM.R_ANKLE]);

  return {
    knee_l: kneeL, knee_r: kneeR, knee: (kneeL + kneeR) / 2,
    hip_l: hipL,   hip_r: hipR,   hip:  (hipL  + hipR)  / 2,
    elbow_l: elbowL, elbow_r: elbowR, elbow: (elbowL + elbowR) / 2,
    torso_lean: verticalAngle(shoulderMid, hipMid),
    body_line:  angleAt(shoulderMid, hipMid, ankleMid),
    hip_below_knee: hipMid.y - (p[LM.L_KNEE].y + p[LM.R_KNEE].y) / 2,
  };
}
