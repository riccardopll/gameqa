# GameQA

GameQA is a local CLI for AI-driven playtesting of web games. It uses [Pi](https://pi.dev) to interact with a game instrumented with `gameqa/sdk`, runs the browser in Docker, and saves screenshots, traces, actions, and a test report under `.gameqa/runs`.

## Install

```bash
pnpm add -D gameqa
pi /login
pnpm exec gameqa init
```

`gameqa init` creates `gameqa.config.ts` with a default Pi agent and run settings.

## Quick start

Expose your game's state and legal actions:

```ts
import { client } from "gameqa/sdk";

client.registerController({
  getSnapshot: () => ({
    phase: "agent_turn",
    state: game.state,
    legalActions: game.actions.map(({ id, label }) => ({
      id,
      label,
      metadata: {},
    })),
  }),
  applyAction: (actionId) => game.dispatch(actionId),
});
```

Start the game, then run:

```bash
pnpm exec gameqa run --agent pi-qa --url http://localhost:5173
```

GameQA writes the report and captured evidence to `.gameqa/runs/<run-id>`.

## Demo games

Both included games install the workspace CLI and have a checked-in `gameqa.config.ts` with a game-specific QA persona. Build GameQA once, authenticate Pi, and make sure Docker is running:

```bash
pnpm build
pi /login
```

Then run a game and its QA session in separate terminals (run one demo at a time because both use port 5173):

```bash
# Terminal 1: Crumb Foundry
pnpm demo:cc

# Terminal 2
pnpm demo:cc:qa
```

Or run Neon Range:

```bash
# Terminal 1: Neon Range
pnpm demo:fps

# Terminal 2
pnpm demo:fps:qa
```

Reports are written to `packages/demo-cc/.gameqa/runs` or `packages/demo-fps/.gameqa/runs`.
