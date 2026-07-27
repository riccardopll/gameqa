import { client } from "@gameqa/sdk";
import "./style.css";

type UpgradeId = "mitt" | "cursor" | "oven";
type Upgrade = {
  id: UpgradeId;
  name: string;
  icon: string;
  description: string;
  baseCost: number;
  growth: number;
  clickPower: number;
  cps: number;
};
type ClickerState = {
  cookies: number;
  lifetimeCookies: number;
  owned: Record<UpgradeId, number>;
  savedAt: number;
  message: string;
};

const storageKey = "gameqa.crumb-foundry.v1";
const upgrades: Upgrade[] = [
  {
    id: "mitt",
    name: "Baker's mitt",
    icon: "✦",
    description: "+1 cookie every time you bake",
    baseCost: 20,
    growth: 1.7,
    clickPower: 1,
    cps: 0,
  },
  {
    id: "cursor",
    name: "Clockwork whisk",
    icon: "⚙",
    description: "+0.5 cookies every second",
    baseCost: 15,
    growth: 1.55,
    clickPower: 0,
    cps: 0.5,
  },
  {
    id: "oven",
    name: "Ember oven",
    icon: "♨",
    description: "+4 cookies every second",
    baseCost: 100,
    growth: 1.65,
    clickPower: 0,
    cps: 4,
  },
];

const freshState = (): ClickerState => ({
  cookies: 0,
  lifetimeCookies: 0,
  owned: { mitt: 0, cursor: 0, oven: 0 },
  savedAt: Date.now(),
  message: "Tap the cookie to start the ovens.",
});

const safeNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

const loadState = (): ClickerState => {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Partial<ClickerState>;
    if (!value || typeof value !== "object") return freshState();
    const loaded: ClickerState = {
      cookies: safeNumber(value.cookies),
      lifetimeCookies: safeNumber(value.lifetimeCookies),
      owned: {
        mitt: Math.floor(safeNumber(value.owned?.mitt)),
        cursor: Math.floor(safeNumber(value.owned?.cursor)),
        oven: Math.floor(safeNumber(value.owned?.oven)),
      },
      savedAt: safeNumber(value.savedAt) || Date.now(),
      message: "Welcome back to the foundry.",
    };
    const elapsedSeconds = Math.min(14_400, Math.max(0, Date.now() - loaded.savedAt) / 1000);
    const offlineCookies = productionRate(loaded) * elapsedSeconds;
    loaded.cookies += offlineCookies;
    loaded.lifetimeCookies += offlineCookies;
    if (offlineCookies >= 0.1) {
      loaded.message = `Your foundry baked ${format(offlineCookies)} cookies while you were away.`;
    }
    return loaded;
  } catch {
    return freshState();
  }
};

let state = loadState();
let lastTick = performance.now();
let lastSaved = Date.now();

function productionRate(input = state) {
  return upgrades.reduce((total, upgrade) => total + input.owned[upgrade.id] * upgrade.cps, 0);
}

function clickPower(input = state) {
  return (
    1 + upgrades.reduce((total, upgrade) => total + input.owned[upgrade.id] * upgrade.clickPower, 0)
  );
}

function upgradeCost(upgrade: Upgrade, input = state) {
  return Math.ceil(upgrade.baseCost * upgrade.growth ** input.owned[upgrade.id]);
}

const totalOwned = () => Object.values(state.owned).reduce((total, value) => total + value, 0);
const rounded = (value: number) => Math.round(value * 100) / 100;

function format(value: number) {
  if (value < 1000) return value.toFixed(value < 10 && value % 1 !== 0 ? 1 : 0);
  const units = ["K", "M", "B", "T"];
  let scaled = value;
  let index = -1;
  while (scaled >= 1000 && index < units.length - 1) {
    scaled /= 1000;
    index += 1;
  }
  return `${scaled.toFixed(scaled < 10 ? 1 : 0)}${units[index]}`;
}

const element = <T extends HTMLElement>(id: string) => {
  const found = document.querySelector<T>(`#${id}`);
  if (!found) throw new Error(`Missing clicker element: ${id}`);
  return found;
};

const save = () => {
  state.savedAt = Date.now();
  localStorage.setItem(storageKey, JSON.stringify(state));
  lastSaved = Date.now();
};

const render = () => {
  element("cookies").textContent = format(state.cookies);
  element("cps").textContent = format(productionRate());
  element("click-power").textContent = format(clickPower());
  element("lifetime").textContent = format(state.lifetimeCookies);
  element("owned").textContent = String(totalOwned());
  element("message").textContent = state.message;
  element("economy-status").textContent = state.cookies >= 0 ? "Economy stable" : "Economy error";

  const list = element("upgrades");
  for (const upgrade of upgrades) {
    const cost = upgradeCost(upgrade);
    const button = element<HTMLButtonElement>(`upgrade-${upgrade.id}`);
    button.disabled = state.cookies < cost;
    button.classList.toggle("affordable", state.cookies >= cost);
    list.querySelector<HTMLElement>(`[data-cost="${upgrade.id}"]`)!.textContent =
      `${format(cost)} cookies`;
    list.querySelector<HTMLElement>(`[data-owned="${upgrade.id}"]`)!.textContent =
      `Owned ${state.owned[upgrade.id]}`;
  }
};

const bake = (amount = clickPower()) => {
  const awarded = Math.max(0, amount);
  state.cookies += awarded;
  state.lifetimeCookies += awarded;
  state.message = `Baked ${format(awarded)} cookie${awarded === 1 ? "" : "s"}.`;
  client.event("cookie_baked", { amount: rounded(awarded), balance: rounded(state.cookies) });
  client.metric("cookie_balance", rounded(state.cookies));
  render();
};

const purchase = (id: UpgradeId) => {
  const upgrade = upgrades.find((candidate) => candidate.id === id);
  if (!upgrade) throw new Error(`Unknown upgrade: ${id}`);
  const cost = upgradeCost(upgrade);
  if (state.cookies < cost) throw new Error(`${upgrade.name} requires ${cost} cookies`);
  state.cookies -= cost;
  state.owned[id] += 1;
  state.message = `${upgrade.name} added to the production line.`;
  client.event("upgrade_purchased", {
    upgradeId: id,
    cost,
    owned: state.owned[id],
    balance: rounded(state.cookies),
  });
  client.metric("cookies_per_second", rounded(productionRate()));
  save();
  render();
};

const reset = () => {
  state = freshState();
  lastTick = performance.now();
  localStorage.removeItem(storageKey);
  client.event("bakery_reset");
  render();
};

const seedBakery = () => {
  state.cookies = 250;
  state.lifetimeCookies = Math.max(state.lifetimeCookies, 250);
  state.message = "QA scenario loaded with 250 cookies.";
  client.event("bakery_seeded", { cookies: 250 });
  render();
};

for (const upgrade of upgrades) {
  const button = document.createElement("button");
  button.id = `upgrade-${upgrade.id}`;
  button.type = "button";
  button.className = "upgrade";
  button.innerHTML = `
    <span class="upgrade-icon" aria-hidden="true">${upgrade.icon}</span>
    <span class="upgrade-copy">
      <strong>${upgrade.name}</strong>
      <span>${upgrade.description}</span>
      <small><span data-cost="${upgrade.id}"></span> · <span data-owned="${upgrade.id}"></span></small>
    </span>`;
  button.addEventListener("click", () => purchase(upgrade.id));
  element("upgrades").append(button);
}

client.registerController({
  getSnapshot: () => ({
    phase: "running",
    state: {
      game: "crumb_foundry",
      cookies: rounded(state.cookies),
      lifetimeCookies: rounded(state.lifetimeCookies),
      cookiesPerSecond: rounded(productionRate()),
      clickPower: rounded(clickPower()),
      upgrades: { ...state.owned },
      nextCosts: Object.fromEntries(upgrades.map((upgrade) => [upgrade.id, upgradeCost(upgrade)])),
      economyValid: state.cookies >= 0,
    },
    legalActions: [
      {
        id: "bake_cookie",
        label: "Bake cookie",
        description: `Award ${format(clickPower())} cookies.`,
        metadata: { amount: rounded(clickPower()) },
      },
      ...upgrades
        .filter((upgrade) => state.cookies >= upgradeCost(upgrade))
        .map((upgrade) => ({
          id: `buy_${upgrade.id}`,
          label: `Buy ${upgrade.name}`,
          description: upgrade.description,
          metadata: { cost: upgradeCost(upgrade), owned: state.owned[upgrade.id] },
        })),
    ],
    message: state.message,
  }),
  applyAction: (actionId) => {
    if (actionId === "bake_cookie") return bake();
    if (actionId.startsWith("buy_")) return purchase(actionId.slice(4) as UpgradeId);
    throw new Error(`Unknown clicker action: ${actionId}`);
  },
});

client.registerDriver({
  observe: () => ({
    phase: "running",
    state: {
      game: "crumb_foundry",
      cookies: rounded(state.cookies),
      cookiesPerSecond: rounded(productionRate()),
      clickPower: rounded(clickPower()),
      upgrades: { ...state.owned },
    },
    message: state.message,
  }),
  goals: {
    bakeMany: (args) => {
      const count = Math.min(1000, Math.max(1, Math.floor(Number(args.count) || 1)));
      bake(clickPower() * count);
    },
    buyBestAffordable: () => {
      let affordable: Upgrade | undefined;
      for (let index = upgrades.length - 1; index >= 0; index -= 1) {
        const candidate = upgrades[index];
        if (candidate && state.cookies >= upgradeCost(candidate)) {
          affordable = candidate;
          break;
        }
      }
      if (!affordable) throw new Error("No upgrade is currently affordable");
      purchase(affordable.id);
    },
  },
  scenarios: {
    resetBakery: () => reset(),
    seedBakery: () => seedBakery(),
  },
});

client.markGoal("build_working_bakery", { target: "purchase an automatic producer" });
element<HTMLButtonElement>("cookie").addEventListener("click", () => bake());
element<HTMLButtonElement>("reset").addEventListener("click", () => {
  if (globalThis.confirm("Reset all Crumb Foundry progress?")) reset();
});

const tick = (now: number) => {
  const elapsed = Math.min(1, Math.max(0, now - lastTick) / 1000);
  lastTick = now;
  const produced = productionRate() * elapsed;
  if (produced > 0) {
    state.cookies += produced;
    state.lifetimeCookies += produced;
  }
  if (Date.now() - lastSaved > 2000) save();
  render();
  requestAnimationFrame(tick);
};

render();
requestAnimationFrame(tick);
