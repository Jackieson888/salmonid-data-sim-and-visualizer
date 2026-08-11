// boids.js
// Classic Reynolds flocking (separation, alignment, cohesion) with a few
// fish-specific additions: a gentle downstream drift, current drag, and
// edge steering so the school stays inside the open rectangular channel.
// The run flows left to right: fish are spawned near the left edge (see
// main.js) and exit once they cross the right edge (see Flock.step).
//
// Depth (fish.depth, 0 = surface .. 1 = riverbed) is a second, independent
// wandering process — cosmetic only, never read by the horizontal flocking
// forces — that drives the 3D renderer's vertical swim position (see
// scene/fishMesh.js) so fish visibly cruise up and down through the water
// column instead of skimming a fixed depth.

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

    // Vertical wander: eases toward a randomly re-picked target depth,
    // occasionally retargeting, so fish drift up and down the water column
    // on their own independent timers instead of all bobbing in lockstep.
    this.depth = 0.2 + Math.random() * 0.6;
    this.depthTarget = this.depth;
    this.depthCooldown = 60 + Math.random() * 150;
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

      // Separation: steer away from the (inverse-distance-weighted) average
      // direction to nearby neighbors, so fish don't pile on top of each other.
      if (sepCount > 0) {
        ax += (sepX / sepCount) * this.options.separationWeight;
        ay += (sepY / sepCount) * this.options.separationWeight;
      }
      // Alignment: steer velocity toward the neighborhood's average velocity,
      // so nearby fish gradually match heading/speed.
      if (aliCount > 0) {
        const avgVx = aliX / aliCount,
          avgVy = aliY / aliCount;
        ax += (avgVx - fish.vx) * 0.05 * this.options.alignmentWeight;
        ay += (avgVy - fish.vy) * 0.05 * this.options.alignmentWeight;
      }
      // Cohesion: steer toward the neighborhood's average position, so the
      // school stays loosely grouped instead of drifting apart.
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

      // Steer away from the top/bottom edges and the left spawn edge. The
      // right edge is intentionally left open so fish can exit downstream.
      const { margin, edgeSteer } = this.options;
      if (fish.y < margin) ay += edgeSteer;
      if (fish.y > this.bounds.height - margin) ay -= edgeSteer;
      if (fish.x < margin) ax += edgeSteer;

      // Clamp steering force so no single frame can yank a fish's heading
      // around too sharply, regardless of how strong the combined forces are.
      const forceMag = Math.hypot(ax, ay);
      const maxForce = this.options.maxForce;
      if (forceMag > maxForce) {
        ax = (ax / forceMag) * maxForce;
        ay = (ay / forceMag) * maxForce;
      }

      // Integrate: apply the clamped steering force to velocity.
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

      // Integrate: apply velocity to position.
      fish.x += fish.vx * dt;
      fish.y += fish.vy * dt;

      // Hard clamp: even though the steering above discourages it, flocking
      // forces can still push a fish past the top/bottom edge.
      if (fish.y < 0) {
        fish.y = 0;
        fish.vy *= -0.5;
      }
      if (fish.y > this.bounds.height) {
        fish.y = this.bounds.height;
        fish.vy *= -0.5;
      }

      // Vertical wander, fully decoupled from the horizontal steering above.
      fish.depthCooldown -= dt;
      if (fish.depthCooldown <= 0) {
        fish.depthTarget = 0.1 + Math.random() * 0.8;
        fish.depthCooldown = 90 + Math.random() * 150;
      }
      fish.depth += (fish.depthTarget - fish.depth) * 0.01 * dt;
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
