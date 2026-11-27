export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  if (dimension <= 0) return 0;
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

export function projectVelocity(velocityPxPerSec: number, decelerationRate = 0.992): number {
  if (!Number.isFinite(velocityPxPerSec) || decelerationRate >= 1 || decelerationRate <= 0) {
    return 0;
  }
  return ((velocityPxPerSec / 1000) * decelerationRate) / (1 - decelerationRate);
}

export interface SpringConfig {
  response: number;
  dampingRatio: number;
}

export interface SpringBody {
  value: number;
  velocity: number;
  target: number;
}

/**
 * Advances a critically/under-damped spring simulation by dtSec.
 * Returns true when the body has settled at target within tight epsilon.
 */
export function springStep(body: SpringBody, config: SpringConfig, dtSec: number): boolean {
  const dt = clamp(dtSec, 0.001, 0.05);
  const response = Math.max(0.05, config.response);
  const zeta = Math.max(0.05, config.dampingRatio);
  const omega = (2 * Math.PI) / response;

  const disp = body.value - body.target;
  const accel = -omega * omega * disp - 2 * zeta * omega * body.velocity;
  body.velocity += accel * dt;
  body.value += body.velocity * dt;

  if (Math.abs(body.value - body.target) < 0.001 && Math.abs(body.velocity) < 0.001) {
    body.value = body.target;
    body.velocity = 0;
    return true;
  }
  return false;
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
