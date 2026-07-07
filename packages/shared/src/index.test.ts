import { describe, expect, it } from "vitest";
import {
    agentDecisionSchema,
    controllerSnapshotSchema,
    configSchema,
    reportSchema,
    runnerJobSchema,
    sdkEventBatchSchema,
} from "./index";

describe("shared contracts", () => {
    it("loads the minimal local config", () => {
        const config = configSchema.parse({
            agents: [
                {
                    id: "codex-qa",
                    adapter: "codex",
                    persona: "Find broken game state.",
                },
            ],
        });

        expect(config.run.outputDir).toBe(".gameqa/runs");
        expect(config.run.maxTurns).toBe(20);
        expect(config.agents[0]?.adapter).toBe("codex");
    });

    it("validates one local runner job", () => {
        const job = runnerJobSchema.parse({
            runId: "run_test",
            sessionId: "session_test",
            targetUrl: "http://host.docker.internal:5173",
            bridgeUrl: "http://host.docker.internal:3900",
            maxTurns: 5,
            timeoutSeconds: 60,
        });

        expect(job.workDir).toBe("/gameqa-run");
    });

    it("validates SDK event batches without hosted credentials", () => {
        const parsed = sdkEventBatchSchema.parse({
            sessionId: "session_test",
            events: [
                {
                    type: "sdk_initialized",
                    name: "sdk_initialized",
                    payload: {},
                    createdAt: new Date().toISOString(),
                },
            ],
        });

        expect(parsed.events).toHaveLength(1);
    });

    it("validates controller snapshots and model decisions", () => {
        const snapshot = controllerSnapshotSchema.parse({
            phase: "agent_turn",
            state: { hp: 10 },
            legalActions: [{ id: "play_block", label: "Play Block" }],
        });
        const choice = agentDecisionSchema.parse({
            type: "controller_action",
            actionId: "play_block",
            reason: "Prevent lethal damage.",
        });

        expect(choice).toMatchObject({
            type: "controller_action",
            actionId: snapshot.legalActions[0]?.id,
        });
    });

    it("validates final reports", () => {
        const report = reportSchema.parse({
            summary: "The match completed with one HUD issue.",
            findings: [
                {
                    id: "hud-health",
                    severity: "medium",
                    title: "Health HUD was unreadable",
                    description:
                        "The SDK reported health but the screenshot text was unclear.",
                    evidence: "screenshots/turn-2.png",
                    recommendation: "Increase health text contrast.",
                },
            ],
            confidence: 0.8,
        });

        expect(report.recommendations).toEqual([]);
    });
});
