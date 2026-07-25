import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SdkInspection } from "gameqa/shared";
import { createClient } from "./index";

type Bridge = {
  inspect: () => Promise<SdkInspection>;
  applyControllerAction: (actionId: string) => Promise<{ ok: boolean; error?: string }>;
  runDriverGoal: (
    goal: string,
    args?: Record<string, never>,
  ) => Promise<{ ok: boolean; error?: string }>;
  runScenario: (
    scenario: string,
    args?: Record<string, never>,
  ) => Promise<{ ok: boolean; error?: string }>;
};

const getBridge = () =>
  (
    globalThis as typeof globalThis & {
      __GAMEQA_AGENT__?: Bridge;
    }
  ).__GAMEQA_AGENT__;

describe("GameQA SDK", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.unstubAllGlobals();
  });

  it("stays inactive when no local session is provided", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const sdk = createClient();
    const init = sdk.init();
    sdk.event("ignored");
    await sdk.flush();

    expect(init.active).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("batches local session events", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const sdk = createClient();
    sdk.init({
      apiUrl: "http://localhost:3900",
      sessionId: "session_test",
    });
    sdk.event("card_seen", { card: "Strike" });

    await sdk.flush();

    const init = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as {
      sessionId: string;
      events: Array<{ name: string }>;
    };

    expect(body.sessionId).toBe("session_test");
    expect(body.events.map((event) => event.name)).toEqual(["sdk_initialized", "card_seen"]);
  });

  it("exposes controller inspection and actions", async () => {
    const sdk = createClient();
    sdk.init({
      apiUrl: "http://localhost:3900",
      sessionId: "session_test",
    });
    let applied = "";
    sdk.registerController({
      getSnapshot: () => ({
        phase: "agent_turn",
        state: { hp: 8 },
        legalActions: [{ id: "play_block", label: "Play Block", metadata: {} }],
      }),
      applyAction: (actionId) => {
        applied = actionId;
      },
    });

    const inspection = await getBridge()?.inspect();
    await getBridge()?.applyControllerAction("play_block");

    expect(inspection?.controller?.phase).toBe("agent_turn");
    expect(applied).toBe("play_block");
  });

  it("exposes driver observation, goals, and scenarios", async () => {
    const sdk = createClient();
    sdk.init({
      apiUrl: "http://localhost:3900",
      sessionId: "session_test",
    });
    const calls: string[] = [];
    sdk.registerDriver({
      observe: () => ({
        phase: "running",
        state: { health: 76 },
      }),
      goals: {
        playMatch: () => {
          calls.push("playMatch");
        },
      },
      scenarios: {
        reset: () => {
          calls.push("reset");
        },
      },
    });

    const inspection = await getBridge()?.inspect();
    await getBridge()?.runDriverGoal("playMatch");
    await getBridge()?.runScenario("reset");

    expect(inspection?.driver?.goals).toEqual(["playMatch"]);
    expect(inspection?.driver?.scenarios).toEqual(["reset"]);
    expect(calls).toEqual(["playMatch", "reset"]);
  });

  it("throws on duplicate controller or driver registration", () => {
    const sdk = createClient();
    sdk.registerController({
      getSnapshot: () => ({
        phase: "waiting",
        state: {},
        legalActions: [],
      }),
      applyAction: () => undefined,
    });
    sdk.registerDriver({
      observe: () => ({
        phase: "running",
        state: {},
      }),
    });

    expect(() =>
      sdk.registerController({
        getSnapshot: () => ({
          phase: "waiting",
          state: {},
          legalActions: [],
        }),
        applyAction: () => undefined,
      }),
    ).toThrow("GameQA controller is already registered");
    expect(() =>
      sdk.registerDriver({
        observe: () => ({
          phase: "running",
          state: {},
        }),
      }),
    ).toThrow("GameQA driver is already registered");
  });
});
