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
        "Test Neon Range as a rigorous game QA tester. Exercise deployment, movement, aiming and firing, both weapons, ammo and reload behavior, target damage and scoring, reset behavior, and HUD feedback.",
    },
  ],
};
