import { describe, expect, it } from "vitest";
import { assertHttpTarget, chromiumLaunchOptions, injectedSession } from "./index";
import type { RunnerJob } from "@gameqa/shared";

const job: RunnerJob = {
  runId: "run_test",
  sessionId: "session_test",
  authToken: "a".repeat(32),
  targetUrl: "http://host.docker.internal:5173/game",
  bridgeUrl: "http://host.docker.internal:3900",
  maxTurns: 5,
  timeoutSeconds: 60,
  settleMs: 0,
  workDir: "/gameqa-run",
};

describe("browser runner", () => {
  it("injects local session state outside the target URL", () => {
    expect(injectedSession(job)).toEqual({
      sessionId: "session_test",
      apiUrl: "http://host.docker.internal:3900",
      authToken: "a".repeat(32),
    });
  });

  it("allows http and https targets", () => {
    expect(() => assertHttpTarget("http://localhost:5173/game")).not.toThrow();
    expect(() => assertHttpTarget("https://example.com/game")).not.toThrow();
  });

  it("blocks non-http targets", () => {
    expect(() => assertHttpTarget("file:///etc/passwd")).toThrow(
      "Target protocol file: is not allowed",
    );
  });

  it("disables Chromium GPU paths in the browser runner", () => {
    expect(chromiumLaunchOptions).toEqual({
      headless: true,
      args: ["--disable-gpu"],
    });
  });
});
