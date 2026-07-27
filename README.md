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
