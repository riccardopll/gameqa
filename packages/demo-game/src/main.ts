import { client } from "@gameqa/sdk";
import "./style.css";

type DemoState = {
  gold: number;
  flasks: number;
  turns: number;
  message: string;
};

const initialState = (): DemoState => ({
  gold: 0,
  flasks: 0,
  turns: 0,
  message: "The merchant offers an ember flask for 5 gold.",
});

let state = initialState();

const element = <T extends HTMLElement>(id: string) => {
  const found = document.querySelector<T>(`#${id}`);
  if (!found) throw new Error(`Missing demo element: ${id}`);
  return found;
};

const render = () => {
  element("gold").textContent = String(state.gold);
  element("flasks").textContent = String(state.flasks);
  element("turns").textContent = String(state.turns);
  element("message").textContent = state.message;
};

const buyFlask = () => {
  // Intentional demo defect: affordability is never checked.
  state.gold -= 5;
  state.flasks += 1;
  state.turns += 1;
  state.message = "The merchant hands over a flask. Your balance is now below zero.";
  client.event("purchase_completed", { item: "ember_flask", price: 5, gold: state.gold });
  client.metric("gold_balance", state.gold);
  client.error("Economy invariant violated", { invariant: "gold >= 0", gold: state.gold });
  console.error(`Economy invariant violated: gold=${state.gold}`);
  render();
};

const searchCounter = () => {
  state.gold += 1;
  state.turns += 1;
  state.message = "You find one coin under the counter.";
  client.event("counter_searched", { gold: state.gold });
  render();
};

const reset = () => {
  state = initialState();
  client.event("demo_reset");
  render();
};

client.registerController({
  getSnapshot: () => ({
    phase: "agent_turn",
    state: {
      gold: state.gold,
      flasks: state.flasks,
      turns: state.turns,
      message: state.message,
      itemPrice: 5,
    },
    legalActions: [
      {
        id: "buy_flask",
        label: "Buy ember flask",
        description: "Buy one flask for 5 gold.",
        metadata: { price: 5 },
      },
      {
        id: "search_counter",
        label: "Search the counter",
        description: "Look for loose coins.",
        metadata: { price: 0 },
      },
    ],
    message: state.message,
  }),
  applyAction: (actionId) => {
    if (actionId === "buy_flask") {
      buyFlask();
      return;
    }
    if (actionId === "search_counter") {
      searchCounter();
      return;
    }
    throw new Error(`Unknown demo action: ${actionId}`);
  },
});

client.registerDriver({
  observe: () => ({
    phase: "running",
    state: { gold: state.gold, flasks: state.flasks, turns: state.turns },
    message: state.message,
  }),
  goals: {
    buyEmberFlask: () => buyFlask(),
    findCoin: () => searchCounter(),
  },
  scenarios: {
    resetShop: () => reset(),
  },
});

client.markGoal("find_economy_defect", { expectedInvariant: "gold >= 0" });
element<HTMLButtonElement>("buy").addEventListener("click", buyFlask);
element<HTMLButtonElement>("explore").addEventListener("click", searchCounter);
element<HTMLButtonElement>("reset").addEventListener("click", reset);
render();
