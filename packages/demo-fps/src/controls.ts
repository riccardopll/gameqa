export type PlanarOffset = {
  x: number;
  z: number;
};

/**
 * Converts FPS-local input into world-space movement.
 *
 * Three.js cameras face -Z at yaw 0. Positive camera yaw turns toward -X,
 * while negative camera yaw turns toward +X.
 */
export const movementOffset = (
  yaw: number,
  forwardInput: number,
  rightInput: number,
  distance: number,
): PlanarOffset => ({
  x: (-Math.sin(yaw) * forwardInput + Math.cos(yaw) * rightInput) * distance,
  z: (-Math.cos(yaw) * forwardInput - Math.sin(yaw) * rightInput) * distance,
});
