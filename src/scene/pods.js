// pods.js
// Thin bridge between the CPU-side pod clustering in boids.js and the
// water shader's per-pod ripple uniforms (see water.js). clusterFish()
// itself is untouched — only the shape of what we hand to the renderer
// changes (a plain {x, z, radius, phase} list instead of an array of Fish).

import { clusterFish } from "../boids.js";

const POD_THRESHOLD = 40; // fish within this distance (transitively) join the same pod

export function computePods(fish) {
  const clusters = clusterFish(fish, POD_THRESHOLD);
  const pods = [];
  for (const pod of clusters) {
    if (pod.length < 2) continue; // lone fish don't generate a ripple

    // Average the cluster's positions into a single world-space center point.
    let cx = 0;
    let cz = 0;
    for (const f of pod) {
      cx += f.x;
      cz += f.y; // fish.y maps to worldZ
    }
    cx /= pod.length;
    cz /= pod.length;

    // Bigger pods get a wider (capped) ripple; phase is borrowed from one
    // member fish so the ripple's sign oscillates over time (see main.js's emitRipples).
    const radius = 18 + Math.min(pod.length * 1.6, 46);
    pods.push({ x: cx, z: cz, radius, phase: pod[0].wobblePhase });
  }
  return pods;
}
