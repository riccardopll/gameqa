#!/usr/bin/env node

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

if (prompt.includes("Write the final GameQA report.")) {
  process.stdout.write(
    `${JSON.stringify({
      summary: "The shop permits an unaffordable purchase and creates an invalid negative balance.",
      findings: [
        {
          id: "negative-gold-purchase",
          severity: "high",
          title: "Unaffordable flask purchase creates negative gold",
          description:
            "Buying the 5-gold ember flask with zero gold succeeds, adds a flask, and changes gold to -5.",
          evidence: "screenshots/turn-2.txt and events.json",
          recommendation: "Reject buy_flask unless gold is at least the item price.",
        },
      ],
      recommendations: ["Validate affordability before mutating inventory or currency."],
      confidence: 0.99,
    })}\n`,
  );
} else if (prompt.includes('"gold": -5')) {
  process.stdout.write(
    `${JSON.stringify({ type: "finish", reason: "The negative-balance defect is reproduced." })}\n`,
  );
} else {
  process.stdout.write(
    `${JSON.stringify({
      type: "controller_action",
      actionId: "buy_flask",
      reason: "Test whether the shop rejects a purchase with zero gold.",
    })}\n`,
  );
}
