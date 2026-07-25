import {
  controllerSnapshotSchema,
  driverObservationSchema,
  localSessionSchema,
  type ControllerSnapshot,
  type DriverObservation,
  type JsonRecord,
  type LocalSession,
  type SdkEvent,
  type SdkInspection,
} from "@gameqa/shared";

export type InitOptions = {
  environment?: string;
  sessionId?: string;
  apiUrl?: string;
  authToken?: string;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  metadata?: JsonRecord;
};

export type Controller = {
  getSnapshot: () => ControllerSnapshot | Promise<ControllerSnapshot>;
  applyAction: (actionId: string) => void | Promise<void>;
};

export type Driver = {
  observe: () => DriverObservation | Promise<DriverObservation>;
  goals?: Record<string, (args: JsonRecord) => void | Promise<void>>;
  scenarios?: Record<string, (args: JsonRecord) => void | Promise<void>>;
};

type RuntimeState = {
  session: LocalSession | null;
  environment: string;
  flushIntervalMs: number;
  maxBatchSize: number;
  metadata: JsonRecord;
  queue: SdkEvent[];
  timer: ReturnType<typeof setInterval> | null;
  controller: Controller | null;
  driver: Driver | null;
  active: boolean;
};

type RuntimeGlobal = typeof globalThis & {
  __GAMEQA_SESSION__?: {
    sessionId?: string;
    apiUrl?: string;
    authToken?: string;
  };
  __GAMEQA_AGENT__?: {
    inspect: () => Promise<SdkInspection>;
    applyControllerAction: (actionId: string) => Promise<{ ok: boolean; error?: string }>;
    runDriverGoal: (goal: string, args?: JsonRecord) => Promise<{ ok: boolean; error?: string }>;
    runScenario: (scenario: string, args?: JsonRecord) => Promise<{ ok: boolean; error?: string }>;
    flush: () => Promise<{ sent: number; active: boolean }>;
  };
};

const createId = (prefix: string) => {
  const cryptoId = globalThis.crypto?.randomUUID?.();
  if (cryptoId) {
    return `${prefix}_${cryptoId}`;
  }

  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
};

const getViewport = () => {
  if (typeof window === "undefined") {
    return undefined;
  }

  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
};

const normalizeRecord = (value?: Record<string, unknown>) => {
  if (!value) {
    return {};
  }

  return JSON.parse(JSON.stringify(value)) as JsonRecord;
};

const buildUrl = (apiUrl: string, path: string) => `${apiUrl.replace(/\/$/, "")}${path}`;

const getInjectedSession = () => {
  const parsed = localSessionSchema.safeParse((globalThis as RuntimeGlobal).__GAMEQA_SESSION__);
  return parsed.success ? parsed.data : null;
};

const createInitialState = () => {
  const session = getInjectedSession();
  const state: RuntimeState = {
    session,
    environment: "development",
    flushIntervalMs: 1500,
    maxBatchSize: 20,
    metadata: {},
    queue: [],
    timer: null,
    controller: null,
    driver: null,
    active: Boolean(session),
  };

  return state;
};

export const createClient = () => {
  let state = createInitialState();
  let flushOnPagehide: (() => void) | null = null;

  const flush = async () => {
    if (!state.active || !state.session || state.queue.length === 0) {
      return { sent: 0, active: state.active };
    }

    const events = state.queue.splice(0, state.maxBatchSize);
    try {
      const response = await fetch(buildUrl(state.session.apiUrl, "/sdk/events"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.session.authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: state.session.sessionId,
          events,
        }),
        keepalive: true,
      });

      if (!response.ok) {
        state.queue.unshift(...events);
        throw new Error(`GameQA SDK flush failed with ${response.status}`);
      }
    } catch (error) {
      state.queue.unshift(...events);
      throw error;
    }

    return { sent: events.length, active: true };
  };

  const enqueue = (type: SdkEvent["type"], name: string, payload?: Record<string, unknown>) => {
    if (!state.active || !state.session) {
      return;
    }

    state.queue.push({
      id: createId("event"),
      type,
      name,
      payload: {
        ...state.metadata,
        ...normalizeRecord(payload),
        environment: state.environment,
      },
      url: typeof window === "undefined" ? undefined : window.location.href,
      viewport: getViewport(),
      createdAt: new Date().toISOString(),
    });

    if (state.queue.length >= state.maxBatchSize) {
      void flush().catch(() => undefined);
    }
  };

  const inspect = async () => {
    const controller = state.controller
      ? controllerSnapshotSchema.parse(await state.controller.getSnapshot())
      : null;
    const driver = state.driver
      ? {
          observation: driverObservationSchema.parse(await state.driver.observe()),
          goals: Object.keys(state.driver.goals ?? {}),
          scenarios: Object.keys(state.driver.scenarios ?? {}),
        }
      : null;

    if (controller) {
      enqueue("snapshot", "snapshot", controller);
    }
    if (driver) {
      enqueue("driver_observation", "driver_observation", driver.observation);
    }

    return { controller, driver };
  };

  const exposeAgentBridge = () => {
    const target = globalThis as RuntimeGlobal;
    target.__GAMEQA_AGENT__ = {
      inspect,
      applyControllerAction: async (actionId) => {
        if (!state.controller) {
          return { ok: false, error: "No GameQA controller registered" };
        }

        try {
          await state.controller.applyAction(actionId);
          enqueue("controller_action_applied", "controller_action_applied", {
            actionId,
          });
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Controller action failed";
          enqueue("error", "controller_action_failed", { actionId, message });
          return { ok: false, error: message };
        }
      },
      runDriverGoal: async (goal, args = {}) => {
        const handler = state.driver?.goals?.[goal];
        if (!handler) {
          return {
            ok: false,
            error: `No GameQA driver goal registered: ${goal}`,
          };
        }

        try {
          await handler(args);
          enqueue("driver_goal_completed", goal, args);
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Driver goal failed";
          enqueue("error", "driver_goal_failed", { goal, message });
          return { ok: false, error: message };
        }
      },
      runScenario: async (scenario, args = {}) => {
        const handler = state.driver?.scenarios?.[scenario];
        if (!handler) {
          return {
            ok: false,
            error: `No GameQA scenario registered: ${scenario}`,
          };
        }

        try {
          await handler(args);
          enqueue("scenario_completed", scenario, args);
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Scenario failed";
          enqueue("error", "scenario_failed", { scenario, message });
          return { ok: false, error: message };
        }
      },
      flush,
    };
  };

  const init = (options: InitOptions = {}) => {
    if (state.timer) {
      clearInterval(state.timer);
    }
    if (typeof window !== "undefined" && flushOnPagehide) {
      window.removeEventListener("pagehide", flushOnPagehide);
      flushOnPagehide = null;
    }

    const injected = getInjectedSession();
    const session = localSessionSchema.safeParse({
      sessionId: options.sessionId ?? injected?.sessionId,
      apiUrl: options.apiUrl ?? injected?.apiUrl,
      authToken: options.authToken ?? injected?.authToken,
    });

    state = {
      ...state,
      session: session.success ? session.data : null,
      environment: options.environment ?? "development",
      flushIntervalMs: options.flushIntervalMs ?? 1500,
      maxBatchSize: options.maxBatchSize ?? 20,
      metadata: normalizeRecord(options.metadata),
      queue: [],
      active: session.success,
      timer: null,
    };

    exposeAgentBridge();

    state.timer = setInterval(() => {
      void flush().catch(() => undefined);
    }, state.flushIntervalMs);

    if (typeof window !== "undefined") {
      flushOnPagehide = () => {
        void flush().catch(() => undefined);
      };
      window.addEventListener("pagehide", flushOnPagehide);
    }

    enqueue("sdk_initialized", "sdk_initialized", {
      hasController: Boolean(state.controller),
      hasDriver: Boolean(state.driver),
    });

    return {
      active: state.active,
      sessionId: state.session?.sessionId ?? null,
      apiUrl: state.session?.apiUrl ?? null,
    };
  };

  const ensureInitialized = () => {
    exposeAgentBridge();
    if (!state.timer) {
      init();
    }
  };

  const registerController = (controller: Controller) => {
    ensureInitialized();
    if (state.controller) {
      throw new Error("GameQA controller is already registered");
    }

    state.controller = controller;
    enqueue("controller_registered", "controller_registered", {});
  };

  const registerDriver = (driver: Driver) => {
    ensureInitialized();
    if (state.driver) {
      throw new Error("GameQA driver is already registered");
    }

    state.driver = driver;
    enqueue("driver_registered", "driver_registered", {
      goals: Object.keys(driver.goals ?? {}),
      scenarios: Object.keys(driver.scenarios ?? {}),
    });
  };

  const event = (name: string, payload?: Record<string, unknown>) => {
    ensureInitialized();
    enqueue("log", name, payload);
  };

  const metric = (name: string, value: number, payload?: Record<string, unknown>) => {
    ensureInitialized();
    enqueue("metric", name, { ...payload, value });
  };

  const markGoal = (name: string, payload?: Record<string, unknown>) => {
    ensureInitialized();
    enqueue("goal", name, payload);
  };

  const error = (input: Error | string, context?: Record<string, unknown>) => {
    ensureInitialized();
    const normalized =
      typeof input === "string"
        ? { message: input }
        : { message: input.message, stack: input.stack };
    enqueue("error", normalized.message, {
      ...context,
      ...normalized,
    });
  };

  const getState = () => state;

  exposeAgentBridge();

  return {
    init,
    registerController,
    registerDriver,
    event,
    metric,
    markGoal,
    error,
    flush,
    getState,
  };
};

export type Client = ReturnType<typeof createClient>;

export const client = createClient();
