import { z } from "zod";

export type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue };

export type JsonRecord = Record<string, JsonValue>;

export type AgentAdapter = "codex";

export type Config = {
    run: {
        outputDir: string;
        maxTurns: number;
        timeoutSeconds: number;
    };
    agents: Array<{
        id: string;
        adapter: AgentAdapter;
        persona: string;
    }>;
};

export type LocalSession = {
    sessionId: string;
    apiUrl: string;
};

export type GamePhase = "agent_turn" | "running" | "waiting" | "complete" | "failed";

export type LegalAction = {
    id: string;
    label: string;
    description?: string;
    metadata: JsonRecord;
};

export type ControllerSnapshot = {
    phase: GamePhase;
    state: JsonRecord;
    legalActions: LegalAction[];
    message?: string;
};

export type DriverObservation = {
    phase?: GamePhase;
    state: JsonRecord;
    message?: string;
};

export type SdkEventType =
    | "sdk_initialized"
    | "controller_registered"
    | "driver_registered"
    | "snapshot"
    | "driver_observation"
    | "controller_action_applied"
    | "driver_goal_completed"
    | "scenario_completed"
    | "goal"
    | "metric"
    | "error"
    | "log";

export type SdkEvent = {
    id?: string;
    type: SdkEventType;
    name: string;
    payload: JsonRecord;
    url?: string;
    viewport?: {
        width: number;
        height: number;
    };
    createdAt: string;
};

export type SdkEventBatch = {
    sessionId: string;
    events: SdkEvent[];
};

export type SdkInspection = {
    controller: ControllerSnapshot | null;
    driver: {
        observation: DriverObservation;
        goals: string[];
        scenarios: string[];
    } | null;
};

export type ScreenEvidence = {
    screenshotPath: string;
    visibleText: string;
};

export type RunnerJob = {
    runId: string;
    sessionId: string;
    targetUrl: string;
    bridgeUrl: string;
    maxTurns: number;
    timeoutSeconds: number;
    workDir: string;
};

export type DecisionRequest = {
    runId: string;
    sessionId: string;
    turn: number;
    inspection: SdkInspection;
    evidence: ScreenEvidence;
};

export type AgentDecision =
    | {
          type: "controller_action";
          actionId: string;
          reason: string;
      }
    | {
          type: "driver_goal";
          goal: string;
          args: JsonRecord;
          reason: string;
      }
    | {
          type: "scenario";
          scenario: string;
          args: JsonRecord;
          reason: string;
      }
    | {
          type: "finish";
          reason: string;
      };

export type RunnerComplete = {
    runId: string;
    sessionId: string;
    status: "completed" | "failed";
    error?: string;
    metrics: {
        durationSeconds: number;
        turns: number;
        screenshots: number;
    };
};

export type Finding = {
    id: string;
    severity: "info" | "low" | "medium" | "high";
    title: string;
    description: string;
    evidence: string;
    recommendation: string;
};

export type Report = {
    summary: string;
    findings: Finding[];
    recommendations: string[];
    confidence: number;
};

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
    z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(jsonValueSchema),
        z.record(z.string(), jsonValueSchema),
    ]),
);

export const jsonRecordSchema = z.record(z.string(), jsonValueSchema);

export const agentAdapterSchema = z.literal("codex");

export const configSchema = z.object({
    run: z
        .object({
            outputDir: z.string().min(1).default(".gameqa/runs"),
            maxTurns: z.number().int().min(1).max(100).default(20),
            timeoutSeconds: z.number().int().min(10).max(7200).default(300),
        })
        .default({
            outputDir: ".gameqa/runs",
            maxTurns: 20,
            timeoutSeconds: 300,
        }),
    agents: z
        .array(
            z.object({
                id: z.string().min(1),
                adapter: agentAdapterSchema,
                persona: z.string().min(1),
            }),
        )
        .min(1),
});

export const localSessionSchema = z.object({
    sessionId: z.string().min(1),
    apiUrl: z.string().url(),
});

export const gamePhaseSchema = z.enum([
    "agent_turn",
    "running",
    "waiting",
    "complete",
    "failed",
]);

export const legalActionSchema = z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    metadata: jsonRecordSchema.default({}),
});

export const controllerSnapshotSchema = z.object({
    phase: gamePhaseSchema,
    state: jsonRecordSchema.default({}),
    legalActions: z.array(legalActionSchema).default([]),
    message: z.string().optional(),
});

export const driverObservationSchema = z.object({
    phase: gamePhaseSchema.optional(),
    state: jsonRecordSchema.default({}),
    message: z.string().optional(),
});

export const sdkEventTypeSchema = z.enum([
    "sdk_initialized",
    "controller_registered",
    "driver_registered",
    "snapshot",
    "driver_observation",
    "controller_action_applied",
    "driver_goal_completed",
    "scenario_completed",
    "goal",
    "metric",
    "error",
    "log",
]);

export const sdkEventSchema = z.object({
    id: z.string().optional(),
    type: sdkEventTypeSchema,
    name: z.string().min(1),
    payload: jsonRecordSchema.default({}),
    url: z.string().optional(),
    viewport: z
        .object({
            width: z.number(),
            height: z.number(),
        })
        .optional(),
    createdAt: z.string(),
});

export const sdkEventBatchSchema = z.object({
    sessionId: z.string().min(1),
    events: z.array(sdkEventSchema).min(1).max(100),
});

export const sdkInspectionSchema = z.object({
    controller: controllerSnapshotSchema.nullable(),
    driver: z
        .object({
            observation: driverObservationSchema,
            goals: z.array(z.string()),
            scenarios: z.array(z.string()),
        })
        .nullable(),
});

export const screenEvidenceSchema = z.object({
    screenshotPath: z.string().min(1),
    visibleText: z.string(),
});

export const runnerJobSchema = z.object({
    runId: z.string().min(1),
    sessionId: z.string().min(1),
    targetUrl: z.string().url(),
    bridgeUrl: z.string().url(),
    maxTurns: z.number().int().min(1).max(100),
    timeoutSeconds: z.number().int().min(10).max(7200),
    workDir: z.string().min(1).default("/gameqa-run"),
});

export const decisionRequestSchema = z.object({
    runId: z.string().min(1),
    sessionId: z.string().min(1),
    turn: z.number().int().min(1),
    inspection: sdkInspectionSchema,
    evidence: screenEvidenceSchema,
});

export const agentDecisionSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("controller_action"),
        actionId: z.string().min(1),
        reason: z.string().min(1),
    }),
    z.object({
        type: z.literal("driver_goal"),
        goal: z.string().min(1),
        args: jsonRecordSchema.default({}),
        reason: z.string().min(1),
    }),
    z.object({
        type: z.literal("scenario"),
        scenario: z.string().min(1),
        args: jsonRecordSchema.default({}),
        reason: z.string().min(1),
    }),
    z.object({
        type: z.literal("finish"),
        reason: z.string().min(1),
    }),
]);

export const runnerCompleteSchema = z.object({
    runId: z.string().min(1),
    sessionId: z.string().min(1),
    status: z.enum(["completed", "failed"]),
    error: z.string().optional(),
    metrics: z.object({
        durationSeconds: z.number(),
        turns: z.number(),
        screenshots: z.number(),
    }),
});

export const findingSchema = z.object({
    id: z.string().min(1),
    severity: z.enum(["info", "low", "medium", "high"]),
    title: z.string().min(1),
    description: z.string().min(1),
    evidence: z.string().min(1),
    recommendation: z.string().min(1),
});

export const reportSchema = z.object({
    summary: z.string().min(1),
    findings: z.array(findingSchema),
    recommendations: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1),
});
