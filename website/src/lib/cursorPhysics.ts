export interface Point {
  x: number;
  y: number;
}

export interface Spring {
  value: number;
  target: number;
  velocity: number;
  dampingFraction: number;
  response: number;
}

const SUBSTEP_SEC = 1 / 240;
const MAX_STEP_DT = 0.05;
const SETTLE_VELOCITY = 0.06;

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function createSpring(initial: number, dampingFraction = 0.9, response = 0.15): Spring {
  return {
    value: initial,
    target: initial,
    velocity: 0,
    dampingFraction,
    response,
  };
}

export function snapSpring(spring: Spring, val: number): void {
  spring.value = val;
  spring.target = val;
  spring.velocity = 0;
}

/**
 * Semi-implicit sub-stepped harmonic spring integrator (matched to extension cursor physics).
 */
export function stepSpring(spring: Spring, rawDt: number): boolean {
  const dt = clamp(rawDt, 0, MAX_STEP_DT);
  const safeResponse = Math.max(0.008, spring.response);
  const omega = (Math.PI * 2) / safeResponse;
  const stiffness = omega * omega;
  const damping = 2 * spring.dampingFraction * omega;

  let remaining = dt;
  while (remaining > 0) {
    const h = Math.min(SUBSTEP_SEC, remaining);
    const force = (spring.target - spring.value) * stiffness - spring.velocity * damping;
    spring.velocity += force * h;
    spring.value += spring.velocity * h;
    remaining -= h;
  }

  const delta = Math.abs(spring.target - spring.value);
  if (delta < 0.02 && Math.abs(spring.velocity) < SETTLE_VELOCITY) {
    spring.value = spring.target;
    spring.velocity = 0;
    return false;
  }
  return true;
}

export function shortestAngleDelta(fromDeg: number, toDeg: number): number {
  let diff = (toDeg - fromDeg) % 360;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return diff;
}

export function stepAngleSpring(spring: Spring, targetDeg: number, dt: number): boolean {
  spring.target = spring.value + shortestAngleDelta(spring.value, targetDeg);
  return stepSpring(spring, dt);
}

/**
 * Evaluates a curved quadratic Bezier flight path and its tangent derivative.
 */
export function evaluateQuadraticArc(
  start: Point,
  end: Point,
  rawT: number,
  curvature = 0.24,
  side: 1 | -1 = 1
): { point: Point; tangent: Point } {
  const t = clamp(rawT, 0, 1);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.hypot(dx, dy);

  if (dist < 24) {
    return {
      point: { x: lerp(start.x, end.x, t), y: lerp(start.y, end.y, t) },
      tangent: { x: dx, y: dy },
    };
  }

  const nx = -dy / dist;
  const ny = dx / dist;
  const arcOffset = clamp(dist * curvature, 20, 130) * side;
  const ctrl: Point = {
    x: (start.x + end.x) * 0.5 + nx * arcOffset,
    y: (start.y + end.y) * 0.5 + ny * arcOffset,
  };

  const oneMinusT = 1 - t;
  const point: Point = {
    x: oneMinusT * oneMinusT * start.x + 2 * oneMinusT * t * ctrl.x + t * t * end.x,
    y: oneMinusT * oneMinusT * start.y + 2 * oneMinusT * t * ctrl.y + t * t * end.y,
  };

  const tangent: Point = {
    x: 2 * oneMinusT * (ctrl.x - start.x) + 2 * t * (end.x - ctrl.x),
    y: 2 * oneMinusT * (ctrl.y - start.y) + 2 * t * (end.y - ctrl.y),
  };

  return { point, tangent };
}

/**
 * Computes natural cursor banking around the repo's resting -44deg orientation.
 */
export function computeBankRotation(vx: number, vy: number, speed: number): number {
  const REST_ANGLE = -44;
  if (speed < 90) return REST_ANGLE;

  // Horizontal lead tilts arrow forward smoothly without inverting upside down on vertical drops
  const horizBank = clamp(vx / 1500, -1, 1) * 32;
  const vertLift = clamp(-vy / 2200, -1, 1) * 8;
  return REST_ANGLE + clamp(horizBank + vertLift, -36, 36);
}

/**
 * Matches extension squash-and-stretch factor at high transit velocity.
 */
export function computeSpeedStretch(speed: number): number {
  return clamp(1 - speed / 5500, 0.78, 1);
}

/**
 * Gentle oscillatory "thinking wobble" while parked waiting at the top of the page.
 */
export function computeThinkingWobble(elapsedSec: number): number {
  return Math.sin(elapsedSec * 2.5) * 6.5;
}
