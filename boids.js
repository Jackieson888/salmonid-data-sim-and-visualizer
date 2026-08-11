// boids.js
// Classic Reynolds flocking (separation, alignment, cohesion) with a few
// fish-specific additions: a gentle downstream drift, current drag, and
// wall/obstacle avoidance so the school reacts to the riverbanks and dam.
// The run flows left to right: fish are spawned near the left edge (see
// main.js) and exit once they cross the right edge (see Flock.step).

// ---------------------------------------------------------------------
// Riverbank + island geometry — the collision meshes fish steer around
// and hard-clamp against. Expressed as fractions of the canvas so they
// scale with any window size. main.js imports these same functions to
// draw the land, so what's drawn is exactly what fish can't swim through.
// Loosely modeled on a Snake River island reference: a slender, tilted
// island mid-channel between two wavy, natural-looking shorelines.
// ---------------------------------------------------------------------
export const BANK_DEPTH = 0.13; // bank depth as a fraction of height, at rest
const BANK_WAVE_AMP = 0.03; // how far the shoreline wanders off that rest depth
const BANK_WAVE_FREQ = 0.0045; // spatial frequency of that wander, per px of x

export function bankTopY(x, bounds) {
  return (
    bounds.height * (BANK_DEPTH + BANK_WAVE_AMP * Math.sin(x * BANK_WAVE_FREQ))
  );
}

export function bankBottomY(x, bounds) {
  return (
    bounds.height *
    (1 - BANK_DEPTH - BANK_WAVE_AMP * Math.sin(x * BANK_WAVE_FREQ * 1.3 + 2.4))
  );
}

export const ISLAND = {
  cx: 0.46, // center, as a fraction of width/height
  cy: 0.5,
  rx: 0.15, // radii, as a fraction of width/height
  ry: 0.045,
  angle: -0.1, // slight tilt, radians
};

// World (x, y) expressed in the island's own rotated, radius-normalized
// frame: dist 0 = center, dist 1 = right at the edge. Also hands back the
// rotation so callers can convert a direction in this frame back to world
// space without redoing the trig.
export function islandSpace(x, y, bounds) {
  const cx = ISLAND.cx * bounds.width;
  const cy = ISLAND.cy * bounds.height;
  const rx = ISLAND.rx * bounds.width;
  const ry = ISLAND.ry * bounds.height;
  const cos = Math.cos(ISLAND.angle);
  const sin = Math.sin(ISLAND.angle);
  const dx = x - cx;
  const dy = y - cy;
  const localX = (dx * cos + dy * sin) / rx;
  const localY = (-dx * sin + dy * cos) / ry;
  return { dist: Math.hypot(localX, localY), localX, localY, cos, sin, rx, ry };
}

// Inverse of islandSpace's local (unrotated, radius-normalized) coordinates
// back to world (x, y) — used to snap a fish to the island's edge on contact.
export function islandLocalToWorld(localX, localY, bounds, space) {
  const dx = localX * space.rx * space.cos - localY * space.ry * space.sin;
  const dy = localX * space.rx * space.sin + localY * space.ry * space.cos;
  return { x: ISLAND.cx * bounds.width + dx, y: ISLAND.cy * bounds.height + dy };
}

// True if (x, y) is over land — either bank — rather than open channel.
// Used to keep random placement (initial fill, day-jump scrub) out of the
// banks; the island is checked separately since it sits mid-channel.
export function isOverBank(x, y, bounds) {
  return y < bankTopY(x, bounds) || y > bankBottomY(x, bounds);
}

export class Fish {
  constructor(x, y, bounds) {
    this.x = x;
    this.y = y;
    // Mostly rightward (downstream) with some spread, so a freshly spawned
    // fish already reads as part of the flow instead of facing any which way.
    const angle = (Math.random() - 0.5) * Math.PI * 0.5;
    const speed = 1 + Math.random() * 0.5;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.bounds = bounds;
    // Per-fish variation so the school doesn't look uniform/robotic.
    this.length = 30 + Math.random() * 5;
    this.wobblePhase = Math.random() * Math.PI * 1;
    this.wobbleSpeed = 2 + Math.random() * 1;
  }

  get speed() {
    return Math.hypot(this.vx, this.vy);
  }
}

export class Flock {
  constructor(bounds, options = {}) {
    this.bounds = bounds;
    this.fish = [];

    this.options = {
      perceptionRadius: options.perceptionRadius ?? 55,
      separationRadius: options.separationRadius ?? 22,
      maxSpeed: options.maxSpeed ?? 2.6,
      maxForce: options.maxForce ?? 0.05,
      separationWeight: options.separationWeight ?? 1.6,
      alignmentWeight: options.alignmentWeight ?? 1.0,
      cohesionWeight: options.cohesionWeight ?? 0.9,
      flowWeight: options.flowWeight ?? 0.35,
      currentWeight: options.currentWeight ?? 0.18,
      margin: options.margin ?? 60,
      edgeSteer: options.edgeSteer ?? 0.12,
    };
  }

  spawn(x, y) {
    const fish = new Fish(x, y, this.bounds);
    this.fish.push(fish);
    return fish;
  }

  remove(fish) {
    const idx = this.fish.indexOf(fish);
    if (idx !== -1) this.fish.splice(idx, 1);
  }

  setBounds(bounds) {
    this.bounds = bounds;
  }

  step(dt = 1) {
    const { perceptionRadius, separationRadius } = this.options;
    const perceptionSq = perceptionRadius * perceptionRadius;
    const separationSq = separationRadius * separationRadius;

    // Simple O(n^2) neighbor search — plenty fast for a few hundred fish.
    // If scaling up past ~1500 agents, swap in a spatial grid here.
    for (const fish of this.fish) {
      let sepX = 0,
        sepY = 0,
        sepCount = 0;
      let aliX = 0,
        aliY = 0,
        aliCount = 0;
      let cohX = 0,
        cohY = 0,
        cohCount = 0;

      for (const other of this.fish) {
        if (other === fish) continue;
        const dx = other.x - fish.x;
        const dy = other.y - fish.y;
        const distSq = dx * dx + dy * dy;
        if (distSq > perceptionSq || distSq === 0) continue;

        if (distSq < separationSq) {
          sepX -= dx / distSq;
          sepY -= dy / distSq;
          sepCount++;
        }
        aliX += other.vx;
        aliY += other.vy;
        aliCount++;
        cohX += other.x;
        cohY += other.y;
        cohCount++;
      }

      let ax = 0,
        ay = 0;

      if (sepCount > 0) {
        ax += (sepX / sepCount) * this.options.separationWeight;
        ay += (sepY / sepCount) * this.options.separationWeight;
      }
      if (aliCount > 0) {
        const avgVx = aliX / aliCount,
          avgVy = aliY / aliCount;
        ax += (avgVx - fish.vx) * 0.05 * this.options.alignmentWeight;
        ay += (avgVy - fish.vy) * 0.05 * this.options.alignmentWeight;
      }
      if (cohCount > 0) {
        const cx = cohX / cohCount,
          cy = cohY / cohCount;
        ax += (cx - fish.x) * 0.0005 * this.options.cohesionWeight;
        ay += (cy - fish.y) * 0.0005 * this.options.cohesionWeight;
      }

      // Gentle downstream bias — the run flows left (spawn) to right (exit).
      ax += this.options.flowWeight * 0.01;

      // Current drag: a slow lateral drift, like river current pushing back
      ay += Math.sin(fish.x * 0.002) * this.options.currentWeight * 0.01;

      // Steer away from the banks (top/bottom, now following the wavy
      // shoreline rather than a flat margin) and the left spawn edge. The
      // right edge is intentionally left open so fish can exit downstream.
      const { margin, edgeSteer } = this.options;
      const topLimit = bankTopY(fish.x, this.bounds) + margin;
      const bottomLimit = bankBottomY(fish.x, this.bounds) - margin;
      if (fish.y < topLimit) ay += edgeSteer;
      if (fish.y > bottomLimit) ay -= edgeSteer;
      if (fish.x < margin) ax += edgeSteer;

      // Steer around the island, harder the closer the fish gets — the
      // outward direction is computed in the island's own rotated frame
      // (see islandSpace) and rotated back to world space to steer with.
      const island = islandSpace(fish.x, fish.y, this.bounds);
      const islandSteerRadius = 1.5; // normalized distance steering kicks in at
      if (island.dist < islandSteerRadius) {
        const nx = island.localX / (island.dist || 1);
        const ny = island.localY / (island.dist || 1);
        const worldNx = nx * island.cos - ny * island.sin;
        const worldNy = nx * island.sin + ny * island.cos;
        const strength = (islandSteerRadius - island.dist) * edgeSteer * 2;
        ax += worldNx * strength;
        ay += worldNy * strength;
      }

      // Clamp steering force
      const forceMag = Math.hypot(ax, ay);
      const maxForce = this.options.maxForce;
      if (forceMag > maxForce) {
        ax = (ax / forceMag) * maxForce;
        ay = (ay / forceMag) * maxForce;
      }

      fish.vx += ax * dt;
      fish.vy += ay * dt;

      // Clamp speed
      const speed = Math.hypot(fish.vx, fish.vy);
      const maxSpeed = this.options.maxSpeed;
      if (speed > maxSpeed) {
        fish.vx = (fish.vx / speed) * maxSpeed;
        fish.vy = (fish.vy / speed) * maxSpeed;
      } else if (speed < maxSpeed * 0.4) {
        // keep a minimum cruising speed so fish don't stall
        const scale = (maxSpeed * 0.4) / (speed || 1);
        fish.vx *= scale;
        fish.vy *= scale;
      }

      fish.x += fish.vx * dt;
      fish.y += fish.vy * dt;

      // Hard collision: even though the steering above discourages it,
      // flocking forces can still push a fish into the bank or island —
      // so as a last resort, snap it back to the surface it hit. Horizontal
      // exit (right edge) is handled below, once per step rather than per
      // fish.
      const top = bankTopY(fish.x, this.bounds);
      const bottom = bankBottomY(fish.x, this.bounds);
      if (fish.y < top) {
        fish.y = top;
        fish.vy *= -0.5;
      }
      if (fish.y > bottom) {
        fish.y = bottom;
        fish.vy *= -0.5;
      }

      // Same last-resort snap for the island: if the fish ended up inside
      // it, push it back out to the nearest point on the edge.
      const islandAfter = islandSpace(fish.x, fish.y, this.bounds);
      if (islandAfter.dist < 1) {
        const scale = 1 / (islandAfter.dist || 0.0001);
        const edge = islandLocalToWorld(
          islandAfter.localX * scale,
          islandAfter.localY * scale,
          this.bounds,
          islandAfter,
        );
        fish.x = edge.x;
        fish.y = edge.y;
        fish.vx *= -0.5;
        fish.vy *= -0.5;
      }
    }

    // River flow-through: fish that cross the right edge have finished
    // their run and are removed, rather than wrapping back to the start.
    const exitX = this.bounds.width + 40;
    if (this.fish.some((f) => f.x > exitX)) {
      this.fish = this.fish.filter((f) => f.x <= exitX);
    }
  }
}

// ---------------------------------------------------------------------
// Pod clustering — groups fish that are within `threshold` of each other,
// directly or transitively (union-find), so the renderer can draw one
// shared ripple outline per school instead of one per fish.
// Same O(n²) cost class as Flock.step's neighbor search; fine at the
// same fish counts, would need the same spatial-grid fix if that changes.
// ---------------------------------------------------------------------
export function clusterFish(fish, threshold) {
  const n = fish.length;
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(a, b) {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  const thresholdSq = threshold * threshold;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = fish[i].x - fish[j].x;
      const dy = fish[i].y - fish[j].y;
      if (dx * dx + dy * dy <= thresholdSq) union(i, j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(fish[i]);
  }
  return Array.from(groups.values());
}
