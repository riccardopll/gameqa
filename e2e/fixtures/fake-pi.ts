#!/usr/bin/env node

const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

const main = async () => {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;

  if (prompt.includes("Write the final GameQA report.")) {
    if (prompt.includes("upgrade_purchased")) {
      output({
        summary:
          "Crumb Foundry maintained a valid economy while purchasing an Ember oven and starting automatic production.",
        findings: [],
        recommendations: [
          "Continue testing longer offline-production and high-number save states.",
        ],
        confidence: 0.98,
      });
    } else {
      output({
        summary:
          "Neon Range switched from the sidearm to the pulse rifle and fired successfully in the real-time arena.",
        findings: [],
        recommendations: [
          "Extend combat runs to cover target destruction, respawn, and collision boundaries.",
        ],
        confidence: 0.97,
      });
    }
  } else if (prompt.includes('"game": "crumb_foundry"')) {
    if (/"oven": 1(?:,|\s*})/.test(prompt)) {
      output({
        type: "finish",
        reason: "The automatic-production upgrade was purchased successfully.",
      });
    } else if (prompt.includes('"cookies": 250')) {
      output({
        type: "controller_action",
        actionId: "buy_oven",
        reason: "Purchase an automatic producer and verify that the balance remains valid.",
      });
    } else {
      output({
        type: "scenario",
        scenario: "seedBakery",
        args: {},
        reason: "Reach an upgrade purchase without spending many turns on repetitive clicks.",
      });
    }
  } else if (prompt.includes('"game": "neon_range"')) {
    if (prompt.includes('"shotsFired": 1')) {
      output({ type: "finish", reason: "The real-time weapon path produced a recorded shot." });
    } else if (prompt.includes('"weapon": "rifle"')) {
      output({
        type: "controller_action",
        actionId: "fire_weapon",
        reason: "Fire the selected rifle at the target directly ahead.",
      });
    } else {
      output({
        type: "controller_action",
        actionId: "switch_rifle",
        reason: "Exercise weapon switching before firing.",
      });
    }
  } else {
    output({ type: "finish", reason: "No recognized demo state was available." });
  }
};

void main();
