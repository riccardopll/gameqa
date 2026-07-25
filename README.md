# GameQA

GameQA is a local CLI for agent-driven playtesting of SDK-instrumented web games. It gives [Pi](https://pi.dev) a Chromium session, structured game state, screenshots, visible text, and runtime evidence, then writes a replayable local report.

> Status: release candidate. Unit tests and a full Docker E2E fixture are included. The npm package is published by the tag release workflow after npm trusted publishing is configured.

## How it works

```text
instrumented game (`gameqa/sdk`)
        ↕ injected browser bridge
Dockerized Playwright runner
        ↕ authenticated local HTTP bridge
`gameqa` CLI → Pi → validated JSON decision/report
        ↓
.gameqa/runs/<run-id>/
```

The game remains in control: it exposes legal controller actions and/or higher-level driver goals. The agent cannot edit the game or use Pi tools during a playtest.

## Prerequisites

- Node.js 24 (see `.node-version`)
- pnpm 11
- Docker
- [Pi](https://pi.dev) installed and authenticated (`pi /login`)

## Install

After the first npm release:

```bash
pnpm add -D gameqa
pnpm exec gameqa init
```

For repository development:

```bash
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/index.js init
```

## Configure

`gameqa init` creates `gameqa.config.ts`:

```ts
export default {
  run: {
    outputDir: ".gameqa/runs",
    maxTurns: 20,
    timeoutSeconds: 300,
    agentTimeoutSeconds: 120,
    settleMs: 250,
  },
  agents: [
    {
      id: "pi-qa",
      adapter: "pi",
      persona: "Find broken state, unclear feedback, and edge-case failures.",
      // Optional; otherwise Pi uses its configured default:
      // provider: "anthropic",
      // model: "claude-sonnet-4-5",
      // thinking: "medium",
    },
  ],
};
```

## Instrument a game

Install/import the SDK and register a controller:

```ts
import { client } from "gameqa/sdk";

client.registerController({
  getSnapshot: () => ({
    phase: "agent_turn",
    state: { gold: game.gold, inventory: game.inventory },
    legalActions: game.actions.map((action) => ({
      id: action.id,
      label: action.label,
      metadata: {},
    })),
  }),
  applyAction: (actionId) => game.dispatch(actionId),
});

client.event("level_started", { level: 2 });
client.metric("health", game.health);
client.markGoal("reach_exit");
```

Real-time games can expose higher-level behavior:

```ts
client.registerDriver({
  observe: () => ({ phase: "running", state: game.snapshot() }),
  goals: {
    playMatch: (args) => automation.playMatch(args),
  },
  scenarios: {
    resetTutorial: () => automation.resetTutorial(),
  },
});
```

Without an injected GameQA session the SDK stays inactive, so the same build can be used normally.

## Run

Start the game on a host reachable by Docker, then run:

```bash
pnpm exec gameqa run --agent pi-qa --url http://localhost:5173
```

Localhost URLs are translated to `host.docker.internal` for the runner. Override executable/image locations when developing:

```bash
GAMEQA_PI_COMMAND=/path/to/pi \
GAMEQA_RUNNER_IMAGE=gameqa-browser-runner:e2e \
pnpm exec gameqa run --agent pi-qa --url http://localhost:5173
```

Pi is launched in ephemeral print mode with tools, extensions, skills, prompt templates, and context files disabled. Its output is validated against the GameQA decision/report schemas.

## Run artifacts

Each run contains:

```text
run.json                run metadata
session.json            completion status and stop reason
actions.json            validated agent decisions
events.json             SDK event stream
browser.log             console/page/network failures
screenshots/             PNG and visible-text evidence
video.webm              browser recording
trace.zip               Playwright trace
pi/                     prompts and raw responses
report.json             structured report
report.md               readable report
```

Stop reasons distinguish `agent_finish`, `max_turns`, `timeout`, and `failed`.

## Demo game

`packages/demo-game` is an instrumented shop with an intentional economy defect: a five-gold flask can be purchased with zero gold.

```bash
pnpm demo
# open http://localhost:5173
```

In another terminal, after building the runner image:

```bash
pnpm test:e2e
```

The E2E suite uses a deterministic fake Pi executable so CI does not require model credentials. It still exercises the production CLI, SDK, Vite demo, Docker image, Playwright browser, authenticated bridge, evidence capture, decisions, and report generation.

## Development

```bash
pnpm check          # format, lint, typecheck, unit tests, build
pnpm test:e2e       # build image and run full Docker E2E
pnpm test:e2e:run   # rerun E2E with an existing local image
pnpm package:smoke  # install the tarball into a clean consumer fixture
pnpm clean          # remove generated artifacts
pnpm fix            # format and autofix lint findings
```

See [`TODO.md`](TODO.md) for current progress.

## Release process

1. Make `pnpm check`, `pnpm test:e2e`, and `pnpm package:smoke` pass.
2. Update `packages/cli/package.json` version and lockfile.
3. Push a matching tag, for example `v0.1.0`.
4. `.github/workflows/release.yml` verifies the repository, publishes the versioned runner image and npm package with provenance, and creates a GitHub release.

Configure npm trusted publishing for this GitHub repository before the first tag. An `NPM_TOKEN` can be supplied as a fallback. Main-branch runner builds publish `latest` and `sha-<commit>` only after the full CI workflow succeeds.

## Security model

The bridge binds outside localhost so the Docker container can reach it. Every request carries a per-run random bearer token and run/session IDs are validated. Request bodies are bounded. Pi receives no built-in tools or project resources during playtests. Target games should still be treated as untrusted local code and run against disposable builds.

## License

MIT
