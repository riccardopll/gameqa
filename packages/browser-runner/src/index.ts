import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  agentDecisionSchema,
  decisionRequestSchema,
  runnerCompleteSchema,
  runnerJobSchema,
  sdkInspectionSchema,
  type AgentDecision,
  type DecisionRequest,
  type JsonRecord,
  type RunnerComplete,
  type RunnerJob,
  type SdkInspection,
} from "@gameqa/shared";

type BridgePayload<T> = {
  ok?: boolean;
  error?: string;
} & T;

type RunStats = {
  turns: number;
  screenshots: number;
  startedAt: number;
};

export const chromiumLaunchOptions = {
  headless: true,
  args: ["--disable-gpu"],
};

export const injectedSession = (job: RunnerJob) => ({
  sessionId: job.sessionId,
  apiUrl: job.bridgeUrl,
  authToken: job.authToken,
});

export const assertHttpTarget = (targetUrl: string) => {
  const { protocol } = new URL(targetUrl);
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`Target protocol ${protocol} is not allowed`);
  }
};

const parseBridgePayload = <T>(text: string) => {
  if (!text.trim()) {
    return {} as BridgePayload<T>;
  }

  try {
    return JSON.parse(text) as BridgePayload<T>;
  } catch {
    return {} as BridgePayload<T>;
  }
};

const bridge = async <T>(job: RunnerJob, pathName: string, body: unknown) => {
  const response = await fetch(`${job.bridgeUrl}${pathName}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${job.authToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = parseBridgePayload<T>(text);
  if (!response.ok) {
    throw new Error(payload.error ?? `Bridge ${pathName} failed with ${response.status}`);
  }

  return payload;
};

const errorText = (error: unknown) => {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return typeof error === "string" ? error : String(error);
};

const closeBrowser = async (context: BrowserContext | null, browser: Browser | null) => {
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
};

const attachPageLogs = (page: Page, logs: string[]) => {
  page.on("console", (message) => {
    logs.push(
      `${new Date().toISOString()} PAGE ${message.type()} ${message.text().slice(0, 2000)}`,
    );
  });
  page.on("pageerror", (error) => {
    logs.push(`${new Date().toISOString()} PAGE_ERROR ${errorText(error)}`);
  });
  page.on("requestfailed", (request) => {
    logs.push(
      `${new Date().toISOString()} REQUEST_FAILED ${request.url()} ${
        request.failure()?.errorText ?? ""
      }`,
    );
  });
};

const waitForSdk = async (page: Page) => {
  await page.waitForFunction(
    () => {
      const target = globalThis as typeof globalThis & {
        __GAMEQA_AGENT__?: unknown;
      };
      return Boolean(target.__GAMEQA_AGENT__);
    },
    null,
    { timeout: 30000 },
  );
};

const getInspection = async (page: Page) => {
  const raw = await page.evaluate(async () => {
    const target = globalThis as typeof globalThis & {
      __GAMEQA_AGENT__?: {
        inspect: () => Promise<unknown>;
      };
    };
    return target.__GAMEQA_AGENT__?.inspect() ?? null;
  });
  return sdkInspectionSchema.parse(raw);
};

const flushSdk = async (page: Page) => {
  await page.evaluate(async () => {
    const target = globalThis as typeof globalThis & {
      __GAMEQA_AGENT__?: {
        flush: () => Promise<unknown>;
      };
    };
    await target.__GAMEQA_AGENT__?.flush();
  });
};

const applyDecision = async (page: Page, decision: AgentDecision) => {
  if (decision.type === "finish") {
    return;
  }

  const pageDecision = decision as unknown as {
    type: "controller_action" | "driver_goal" | "scenario";
    actionId?: string;
    goal?: string;
    scenario?: string;
    args?: Record<string, unknown>;
  };

  const result = await page.evaluate(async (nextDecision) => {
    const target = globalThis as typeof globalThis & {
      __GAMEQA_AGENT__?: {
        applyControllerAction: (actionId: string) => Promise<{ ok: boolean; error?: string }>;
        runDriverGoal: (
          goal: string,
          args?: JsonRecord,
        ) => Promise<{ ok: boolean; error?: string }>;
        runScenario: (
          scenario: string,
          args?: JsonRecord,
        ) => Promise<{ ok: boolean; error?: string }>;
      };
    };

    if (!target.__GAMEQA_AGENT__) {
      return { ok: false, error: "GameQA SDK bridge missing" };
    }

    if (nextDecision.type === "controller_action") {
      return target.__GAMEQA_AGENT__.applyControllerAction(nextDecision.actionId ?? "");
    }

    if (nextDecision.type === "driver_goal") {
      return target.__GAMEQA_AGENT__.runDriverGoal(
        nextDecision.goal ?? "",
        nextDecision.args as JsonRecord | undefined,
      );
    }

    return target.__GAMEQA_AGENT__.runScenario(
      nextDecision.scenario ?? "",
      nextDecision.args as JsonRecord | undefined,
    );
  }, pageDecision);

  if (!result.ok) {
    throw new Error(result.error ?? "GameQA decision failed");
  }
};

const captureEvidence = async (page: Page, job: RunnerJob, stats: RunStats, turn: number) => {
  const screenshotsDir = path.join(job.workDir, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });
  const screenshotPath = path.join(screenshotsDir, `turn-${turn}.png`);
  await page.screenshot({ path: screenshotPath, type: "png" });
  stats.screenshots += 1;

  const visibleText = await page
    .evaluate(() => document.body?.innerText?.slice(0, 12000) ?? "")
    .catch(() => "");
  await writeFile(path.join(screenshotsDir, `turn-${turn}.txt`), visibleText, "utf8");

  return {
    screenshotPath,
    visibleText,
  };
};

const hasWork = (inspection: SdkInspection) =>
  Boolean(
    inspection.controller ||
    (inspection.driver &&
      (inspection.driver.goals.length > 0 || inspection.driver.scenarios.length > 0)),
  );

const writeLogs = async (job: RunnerJob, logs: string[]) => {
  if (logs.length === 0) {
    return;
  }

  await writeFile(path.join(job.workDir, "browser.log"), logs.join("\n"), "utf8");
};

export const runBrowserSession = async (job: RunnerJob) => {
  assertHttpTarget(job.targetUrl);
  await mkdir(job.workDir, { recursive: true });
  await rm(path.join(job.workDir, "screenshots"), { recursive: true, force: true });
  await mkdir(path.join(job.workDir, "screenshots"), { recursive: true });

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  const logs: string[] = [];
  const stats: RunStats = {
    turns: 0,
    screenshots: 0,
    startedAt: Date.now(),
  };
  const videoDir = path.join(job.workDir, "videos");
  const tracePath = path.join(job.workDir, "trace.zip");
  const deadline = Date.now() + job.timeoutSeconds * 1000;
  let stopReason: RunnerComplete["stopReason"] = "max_turns";

  try {
    await mkdir(videoDir, { recursive: true });
    browser = await chromium.launch(chromiumLaunchOptions);
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordVideo: {
        dir: videoDir,
        size: { width: 1280, height: 800 },
      },
    });
    await context.addInitScript((session) => {
      Object.defineProperty(globalThis, "__GAMEQA_SESSION__", {
        value: session,
        configurable: true,
      });
    }, injectedSession(job));

    const page = await context.newPage();
    attachPageLogs(page, logs);
    await context.tracing.start({ screenshots: true, snapshots: true });
    await page.goto(job.targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await waitForSdk(page);

    for (let turn = 1; turn <= job.maxTurns && Date.now() < deadline; turn += 1) {
      const inspection = await getInspection(page);
      if (!hasWork(inspection)) {
        throw new Error("GameQA SDK has no controller or driver work registered");
      }

      const evidence = await captureEvidence(page, job, stats, turn);
      const request: DecisionRequest = {
        runId: job.runId,
        sessionId: job.sessionId,
        turn,
        inspection,
        evidence,
      };
      const decisionPayload = await bridge<{ decision: unknown }>(
        job,
        "/decision",
        decisionRequestSchema.parse(request),
      );
      const decision = agentDecisionSchema.parse(decisionPayload.decision);
      await writeFile(
        path.join(job.workDir, "last-decision.json"),
        JSON.stringify(decision, null, 2),
        "utf8",
      );
      stats.turns = turn;

      if (decision.type === "finish") {
        stopReason = "agent_finish";
        break;
      }

      await applyDecision(page, decision);
      if (job.settleMs > 0) {
        await page.waitForTimeout(job.settleMs);
      }
      await flushSdk(page).catch(() => undefined);
    }

    if (stopReason !== "agent_finish" && Date.now() >= deadline) {
      stopReason = "timeout";
    }

    await flushSdk(page).catch(() => undefined);
    await context.tracing.stop({ path: tracePath });
    const video = page.video();
    await closeBrowser(context, browser);
    context = null;
    browser = null;

    const videoPath = video ? await video.path().catch(() => null) : null;
    if (videoPath) {
      await copyFile(videoPath, path.join(job.workDir, "video.webm"));
    }
    await rm(videoDir, { recursive: true, force: true });

    const complete = runnerCompleteSchema.parse({
      runId: job.runId,
      sessionId: job.sessionId,
      status: "completed",
      stopReason,
      metrics: {
        durationSeconds: Math.round((Date.now() - stats.startedAt) / 1000),
        turns: stats.turns,
        screenshots: stats.screenshots,
      },
    });
    await bridge(job, "/complete", complete);
    await writeLogs(job, logs);
    return complete;
  } catch (error) {
    await closeBrowser(context, browser);
    const complete = runnerCompleteSchema.parse({
      runId: job.runId,
      sessionId: job.sessionId,
      status: "failed",
      stopReason: "failed",
      error: error instanceof Error ? error.message : "Browser runner failed",
      metrics: {
        durationSeconds: Math.round((Date.now() - stats.startedAt) / 1000),
        turns: stats.turns,
        screenshots: stats.screenshots,
      },
    });
    await writeLogs(job, [...logs, errorText(error)]).catch(() => undefined);
    await bridge(job, "/complete", complete).catch(() => undefined);
    throw error;
  }
};

const runFromEnv = async () => {
  const raw = process.env.GAMEQA_RUNNER_JOB;
  if (!raw) {
    throw new Error("Missing GAMEQA_RUNNER_JOB");
  }

  const job = runnerJobSchema.parse(JSON.parse(raw) as unknown);
  await runBrowserSession(job);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runFromEnv().catch((error) => {
    console.error(errorText(error));
    process.exitCode = 1;
  });
}
