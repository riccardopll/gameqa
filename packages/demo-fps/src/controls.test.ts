import { describe, expect, it } from "vitest";
import { movementOffset } from "./controls";

const expectOffset = (
  yaw: number,
  forward: number,
  right: number,
  expectedX: number,
  expectedZ: number,
) => {
  const offset = movementOffset(yaw, forward, right, 1);
  expect(offset.x).toBeCloseTo(expectedX, 10);
  expect(offset.z).toBeCloseTo(expectedZ, 10);
};

describe("FPS movement", () => {
  it("uses the camera's forward and right axes at the initial heading", () => {
    expect.hasAssertions();
    expectOffset(0, 1, 0, 0, -1);
    expectOffset(0, -1, 0, 0, 1);
    expectOffset(0, 0, 1, 1, 0);
    expectOffset(0, 0, -1, -1, 0);
  });

  it("keeps WASD aligned after looking right", () => {
    expect.hasAssertions();
    expectOffset(-Math.PI / 2, 1, 0, 1, 0);
    expectOffset(-Math.PI / 2, -1, 0, -1, 0);
    expectOffset(-Math.PI / 2, 0, 1, 0, 1);
    expectOffset(-Math.PI / 2, 0, -1, 0, -1);
  });

  it("keeps WASD aligned after looking left", () => {
    expect.hasAssertions();
    expectOffset(Math.PI / 2, 1, 0, -1, 0);
    expectOffset(Math.PI / 2, -1, 0, 1, 0);
    expectOffset(Math.PI / 2, 0, 1, 0, -1);
    expectOffset(Math.PI / 2, 0, -1, 0, 1);
  });
});
