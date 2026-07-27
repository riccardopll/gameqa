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
      persona:
        "Test Crumb Foundry as a rigorous game QA tester. Exercise manual baking, upgrade progression, automatic production, reset and seeded scenarios, and verify that economy state and player feedback remain consistent.",
    },
  ],
};
