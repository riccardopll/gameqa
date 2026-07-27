import { client } from "@gameqa/sdk";
import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { movementOffset } from "./controls";
import "./style.css";

type WeaponId = "sidearm" | "rifle";
type WeaponSpec = {
  id: WeaponId;
  name: string;
  slot: number;
  damage: number;
  magazineSize: number;
  reserveSize: number;
  cadenceMs: number;
  spread: number;
  automatic: boolean;
};
type WeaponState = { ammo: number; reserve: number };
type Target = { id: string; mesh: THREE.Mesh; health: number; active: boolean; respawnAt: number };
type Cover = { x: number; z: number; halfX: number; halfZ: number };

const weapons: Record<WeaponId, WeaponSpec> = {
  sidearm: {
    id: "sidearm",
    name: "SIDEARM",
    slot: 1,
    damage: 34,
    magazineSize: 12,
    reserveSize: 48,
    cadenceMs: 260,
    spread: 0.004,
    automatic: false,
  },
  rifle: {
    id: "rifle",
    name: "PULSE RIFLE",
    slot: 2,
    damage: 24,
    magazineSize: 30,
    reserveSize: 120,
    cadenceMs: 95,
    spread: 0.014,
    automatic: true,
  },
};

const shell = required<HTMLElement>("game-shell");
const canvas = required<HTMLCanvasElement>("viewport");
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07100d);
scene.fog = new THREE.Fog(0x07100d, 18, 46);
const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 100);
scene.add(camera);

const arenaHalf = 14;
const playerRadius = 0.45;
const player = new THREE.Vector3(0, 1.7, 10);
let yaw = 0;
let pitch = -0.03;
let deployed = false;
let firing = false;
let activeWeapon: WeaponId = "sidearm";
let lastShotAt = -Infinity;
let status = "Click Deploy to enter the range.";
let score = 0;
let shotsFired = 0;
let hits = 0;
let targetsDestroyed = 0;
let hitmarkerTimer = 0;
let weaponBob = 0;
const weaponState: Record<WeaponId, WeaponState> = {
  sidearm: { ammo: weapons.sidearm.magazineSize, reserve: weapons.sidearm.reserveSize },
  rifle: { ammo: weapons.rifle.magazineSize, reserve: weapons.rifle.reserveSize },
};
const keys = new Set<string>();
const raycaster = new THREE.Raycaster();
const cover: Cover[] = [
  { x: -5, z: 3, halfX: 1.7, halfZ: 0.65 },
  { x: 5, z: -1, halfX: 1.7, halfZ: 0.65 },
  { x: 0, z: -5.5, halfX: 1.1, halfZ: 1.1 },
];

function required<T extends HTMLElement>(id: string) {
  const result = document.querySelector<T>(`#${id}`);
  if (!result) throw new Error(`Missing FPS element: ${id}`);
  return result;
}

const material = (color: number, options: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.18, ...options });

const addBox = (
  size: [number, number, number],
  position: [number, number, number],
  color: number,
) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material(color));
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
};

scene.add(new THREE.HemisphereLight(0x8fffc5, 0x101614, 1.35));
const sun = new THREE.DirectionalLight(0xc6ffe1, 2.6);
sun.position.set(-8, 16, 9);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -20;
sun.shadow.camera.right = 20;
sun.shadow.camera.top = 20;
sun.shadow.camera.bottom = -20;
scene.add(sun);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(arenaHalf * 2, arenaHalf * 2, 28, 28),
  material(0x14241d, { roughness: 0.92 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const grid = new THREE.GridHelper(arenaHalf * 2, 28, 0x62df9f, 0x29483a);
grid.position.y = 0.012;
scene.add(grid);

addBox([28.8, 4, 0.6], [0, 2, -14.4], 0x172820);
addBox([28.8, 4, 0.6], [0, 2, 14.4], 0x172820);
addBox([0.6, 4, 28], [-14.4, 2, 0], 0x172820);
addBox([0.6, 4, 28], [14.4, 2, 0], 0x172820);
for (const obstacle of cover) {
  addBox([obstacle.halfX * 2, 2.1, obstacle.halfZ * 2], [obstacle.x, 1.05, obstacle.z], 0x29483a);
}
for (let index = -12; index <= 12; index += 4) {
  addBox([0.08, 0.08, 28], [index, 0.04, 0], 0x48a978);
}

const propRoots: THREE.Object3D[] = [];
const propPositions: Array<[number, number, number]> = [
  [-10, 0, -8],
  [-9.2, 0, -8.1],
  [10, 0, 7],
  [10.8, 0, 7.2],
  [-11, 0, 7],
];
const createBarrelFallback = (position: [number, number, number]) => {
  const root = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 1.2, 12), material(0x47705d));
  body.position.y = 0.6;
  body.castShadow = true;
  root.add(body);
  for (const y of [0.18, 0.58, 1.02]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.49, 0.035, 6, 12), material(0x17231e));
    band.rotation.x = Math.PI / 2;
    band.position.y = y;
    root.add(band);
  }
  root.position.set(...position);
  scene.add(root);
  propRoots.push(root);
};
propPositions.forEach(createBarrelFallback);

const licensedAssets = import.meta.glob("./licensed-assets/*.glb", {
  eager: true,
  import: "default",
  query: "?url",
}) as Record<string, string>;

const loadLicensedBarrel = () => {
  const barrelUrl = licensedAssets["./licensed-assets/barrel-01.glb"];
  if (!barrelUrl) return;
  const draco = new DRACOLoader().setDecoderPath("/draco/");
  const loader = new GLTFLoader().setDRACOLoader(draco);
  loader.load(
    barrelUrl,
    (gltf) => {
      propRoots.forEach((root) => scene.remove(root));
      propRoots.length = 0;
      for (const position of propPositions) {
        const root = gltf.scene.clone(true);
        root.position.set(...position);
        root.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
        scene.add(root);
        propRoots.push(root);
      }
      required("asset-status").textContent = "Props: Barrel 01 · threejsassets.com";
      client.event("authored_asset_loaded", {
        asset: "barrel-01.glb",
        source: "threejsassets.com",
      });
      draco.dispose();
    },
    undefined,
    () => draco.dispose(),
  );
};
loadLicensedBarrel();

const targetPositions: Array<[number, number, number]> = [
  [0, 1.7, -8],
  [-8, 1.7, -4],
  [8, 1.7, -6],
];
const targets: Target[] = targetPositions.map((position, index) => {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.62, 0.62, 0.18, 20),
    material(0xff614d, { emissive: 0x5c1008, emissiveIntensity: 0.5, roughness: 0.4 }),
  );
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.userData.targetId = `target_${index + 1}`;
  scene.add(mesh);
  const stand = addBox([0.09, 1.7, 0.09], [position[0], 0.85, position[2] + 0.12], 0x40554b);
  stand.userData.decorative = true;
  return { id: `target_${index + 1}`, mesh, health: 100, active: true, respawnAt: 0 };
});

const gunGroup = new THREE.Group();
const gunBody = new THREE.Mesh(
  new THREE.BoxGeometry(0.22, 0.18, 0.78),
  material(0x17231e, { metalness: 0.75 }),
);
gunBody.position.set(0.34, -0.27, -0.68);
gunGroup.add(gunBody);
const gunAccent = new THREE.Mesh(
  new THREE.BoxGeometry(0.13, 0.04, 0.52),
  material(0x69ffb7, { emissive: 0x1f8c5b, emissiveIntensity: 1 }),
);
gunAccent.position.set(0.34, -0.17, -0.7);
gunGroup.add(gunAccent);
camera.add(gunGroup);

const updateCamera = () => {
  camera.position.copy(player);
  camera.rotation.order = "YXZ";
  camera.rotation.set(pitch, yaw, 0);
};

const updateHud = () => {
  const spec = weapons[activeWeapon];
  const ammo = weaponState[activeWeapon];
  required("score").textContent = String(score);
  required("targets").textContent = String(targets.filter((target) => target.active).length);
  required("accuracy").textContent =
    shotsFired === 0 ? "—" : `${Math.round((hits / shotsFired) * 100)}%`;
  required("weapon-slot").textContent = `0${spec.slot} / ${spec.name}`;
  required("ammo").textContent = String(ammo.ammo);
  required("reserve").textContent = String(ammo.reserve);
  required("weapon-stats").textContent =
    `${spec.automatic ? "AUTO" : "SEMI"} · ${spec.damage} DMG · ${spec.spread < 0.01 ? "HIGH PRECISION" : "MOBILE"}`;
  required("status").textContent = status;
  gunBody.scale.z = activeWeapon === "rifle" ? 1.5 : 0.85;
  gunAccent.scale.z = activeWeapon === "rifle" ? 1.5 : 0.8;
};

const switchWeapon = (id: WeaponId) => {
  if (activeWeapon === id) return;
  activeWeapon = id;
  status = `${weapons[id].name} equipped.`;
  client.event("weapon_switched", { weapon: id, ammo: weaponState[id].ammo });
  updateHud();
};

const flashHitmarker = () => {
  required("hitmarker").classList.add("visible");
  hitmarkerTimer = performance.now() + 120;
};

const fire = (qaAccurate = false) => {
  const now = performance.now();
  const spec = weapons[activeWeapon];
  const ammo = weaponState[activeWeapon];
  if (now - lastShotAt < spec.cadenceMs) return false;
  if (ammo.ammo <= 0) {
    status = "Magazine empty. Press R to reload.";
    updateHud();
    return false;
  }
  lastShotAt = now;
  ammo.ammo -= 1;
  shotsFired += 1;
  gunGroup.position.z = 0.09;

  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);
  if (!qaAccurate) {
    direction.x += (Math.random() - 0.5) * spec.spread;
    direction.y += (Math.random() - 0.5) * spec.spread;
    direction.normalize();
  }
  raycaster.set(camera.position, direction);
  const activeMeshes = targets.filter((target) => target.active).map((target) => target.mesh);
  const intersection = raycaster.intersectObjects(activeMeshes, false)[0];
  let hitTarget: Target | undefined;
  if (intersection) {
    hitTarget = targets.find((target) => target.mesh === intersection.object);
  }
  if (hitTarget) {
    hits += 1;
    hitTarget.health -= spec.damage;
    score += 10;
    flashHitmarker();
    status = `${hitTarget.id.replace("_", " ")} hit for ${spec.damage}.`;
    client.event("target_hit", {
      targetId: hitTarget.id,
      weapon: activeWeapon,
      damage: spec.damage,
      remainingHealth: Math.max(0, hitTarget.health),
    });
    if (hitTarget.health <= 0) {
      hitTarget.active = false;
      hitTarget.mesh.visible = false;
      hitTarget.respawnAt = now + 3000;
      targetsDestroyed += 1;
      score += 90;
      status = `${hitTarget.id.replace("_", " ")} destroyed. Respawning in 3 seconds.`;
      client.event("target_destroyed", { targetId: hitTarget.id, weapon: activeWeapon, score });
    }
  } else {
    status = `${spec.name} fired — no target hit.`;
  }
  client.event("weapon_fired", {
    weapon: activeWeapon,
    ammo: ammo.ammo,
    hit: Boolean(hitTarget),
    shotsFired,
  });
  client.metric("accuracy_percent", shotsFired === 0 ? 0 : Math.round((hits / shotsFired) * 100));
  updateHud();
  return true;
};

const reload = () => {
  const spec = weapons[activeWeapon];
  const ammo = weaponState[activeWeapon];
  const needed = spec.magazineSize - ammo.ammo;
  const moved = Math.min(needed, ammo.reserve);
  if (moved <= 0) {
    status = ammo.ammo === spec.magazineSize ? "Magazine already full." : "No reserve ammunition.";
    updateHud();
    return;
  }
  ammo.ammo += moved;
  ammo.reserve -= moved;
  status = `${spec.name} reloaded (${moved} rounds).`;
  client.event("weapon_reloaded", { weapon: activeWeapon, loaded: moved, reserve: ammo.reserve });
  updateHud();
};

const aimAt = (position: THREE.Vector3) => {
  const delta = position.clone().sub(player);
  yaw = Math.atan2(-delta.x, -delta.z);
  pitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z));
  updateCamera();
};

const movePlayer = (forward: number, right: number, distance = 0.8) => {
  const offset = movementOffset(yaw, forward, right, distance);
  const next = player.clone();
  next.x += offset.x;
  next.z += offset.z;
  next.x = THREE.MathUtils.clamp(next.x, -arenaHalf + playerRadius, arenaHalf - playerRadius);
  next.z = THREE.MathUtils.clamp(next.z, -arenaHalf + playerRadius, arenaHalf - playerRadius);
  const blocked = cover.some(
    (obstacle) =>
      Math.abs(next.x - obstacle.x) < obstacle.halfX + playerRadius &&
      Math.abs(next.z - obstacle.z) < obstacle.halfZ + playerRadius,
  );
  if (!blocked) player.copy(next);
  updateCamera();
};

const resetRange = () => {
  player.set(0, 1.7, 10);
  yaw = 0;
  pitch = -0.03;
  activeWeapon = "sidearm";
  weaponState.sidearm = {
    ammo: weapons.sidearm.magazineSize,
    reserve: weapons.sidearm.reserveSize,
  };
  weaponState.rifle = { ammo: weapons.rifle.magazineSize, reserve: weapons.rifle.reserveSize };
  score = 0;
  shotsFired = 0;
  hits = 0;
  targetsDestroyed = 0;
  lastShotAt = -Infinity;
  for (const target of targets) {
    target.health = 100;
    target.active = true;
    target.respawnAt = 0;
    target.mesh.visible = true;
  }
  status = "Range reset. Three targets active.";
  updateCamera();
  updateHud();
  client.event("range_reset");
};

const snapshot = () => ({
  game: "neon_range",
  realtime: true,
  deployed,
  position: {
    x: Math.round(player.x * 100) / 100,
    y: player.y,
    z: Math.round(player.z * 100) / 100,
  },
  orientation: { yaw: Math.round(yaw * 1000) / 1000, pitch: Math.round(pitch * 1000) / 1000 },
  weapon: activeWeapon,
  ammo: weaponState[activeWeapon].ammo,
  reserve: weaponState[activeWeapon].reserve,
  score,
  shotsFired,
  hits,
  accuracy: shotsFired === 0 ? 0 : Math.round((hits / shotsFired) * 100),
  targetsDestroyed,
  activeTargets: targets
    .filter((target) => target.active)
    .map((target) => ({ id: target.id, health: target.health })),
});

const action = (
  id: string,
  label: string,
  metadata: Record<string, string | number | boolean>,
) => ({ id, label, metadata });

const deployRange = () => {
  if (deployed) return;
  deployed = true;
  required("launch-panel").classList.add("hidden");
  status = "Range live. Acquire a red target and fire.";
  updateHud();
  client.event("range_deployed");
};

client.registerController({
  getSnapshot: () => ({
    phase: "running",
    state: snapshot(),
    legalActions: [
      action("move_forward", "Move forward", { distance: 0.8 }),
      action("turn_left", "Turn left", { radians: 0.2 }),
      action("turn_right", "Turn right", { radians: 0.2 }),
      action("fire_weapon", `Fire ${weapons[activeWeapon].name}`, { weapon: activeWeapon }),
      action("reload_weapon", "Reload weapon", { weapon: activeWeapon }),
      activeWeapon === "sidearm"
        ? action("switch_rifle", "Switch to pulse rifle", { slot: 2 })
        : action("switch_sidearm", "Switch to sidearm", { slot: 1 }),
    ],
    message: status,
  }),
  applyAction: (actionId) => {
    deployRange();
    if (actionId === "move_forward") return movePlayer(1, 0);
    if (actionId === "turn_left") {
      yaw += 0.2;
      return updateCamera();
    }
    if (actionId === "turn_right") {
      yaw -= 0.2;
      return updateCamera();
    }
    if (actionId === "switch_rifle") return switchWeapon("rifle");
    if (actionId === "switch_sidearm") return switchWeapon("sidearm");
    if (actionId === "reload_weapon") return reload();
    if (actionId === "fire_weapon") {
      fire(true);
      return;
    }
    throw new Error(`Unknown FPS action: ${actionId}`);
  },
});

client.registerDriver({
  observe: () => ({ phase: "running", state: snapshot(), message: status }),
  goals: {
    engageNearestTarget: (args) => {
      const requested = args.weapon === "sidearm" ? "sidearm" : "rifle";
      switchWeapon(requested);
      const target = targets.find((candidate) => candidate.active);
      if (!target) throw new Error("No active target to engage");
      aimAt(target.mesh.position);
      lastShotAt = -Infinity;
      fire(true);
    },
    moveAndFire: () => {
      movePlayer(1, 0, 1.5);
      const target = targets.find((candidate) => candidate.active);
      if (target) aimAt(target.mesh.position);
      lastShotAt = -Infinity;
      fire(true);
    },
  },
  scenarios: { resetRange: () => resetRange() },
});
client.markGoal("exercise_realtime_combat", { expectedWeapons: 2, expectedTargets: 3 });

shell.addEventListener("click", (event) => {
  if (event.target === required("reset") || event.target === required("deploy")) return;
  if (document.pointerLockElement === canvas) fire();
});
required<HTMLButtonElement>("deploy").addEventListener("click", () => {
  deployRange();
  canvas.requestPointerLock();
});
required<HTMLButtonElement>("reset").addEventListener("click", () => resetRange());
document.addEventListener("keydown", (event) => {
  keys.add(event.code);
  if (event.code === "Digit1") switchWeapon("sidearm");
  if (event.code === "Digit2") switchWeapon("rifle");
  if (event.code === "KeyR") reload();
});
document.addEventListener("keyup", (event) => keys.delete(event.code));
document.addEventListener("mousedown", (event) => {
  if (event.button === 0) firing = true;
});
document.addEventListener("mouseup", () => {
  firing = false;
});
document.addEventListener("mousemove", (event) => {
  if (document.pointerLockElement !== canvas) return;
  yaw -= event.movementX * 0.0022;
  pitch = THREE.MathUtils.clamp(pitch - event.movementY * 0.0022, -1.35, 1.35);
});

const resize = () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
};
addEventListener("resize", resize);
resize();
updateCamera();
updateHud();

const clock = new THREE.Clock();
const animate = () => {
  const delta = Math.min(clock.getDelta(), 0.05);
  const moving = Number(keys.has("KeyW")) - Number(keys.has("KeyS"));
  const strafing = Number(keys.has("KeyD")) - Number(keys.has("KeyA"));
  if (deployed && (moving !== 0 || strafing !== 0)) {
    const length = Math.hypot(moving, strafing) || 1;
    movePlayer(moving / length, strafing / length, delta * 5.2);
    weaponBob += delta * 11;
  }
  if (firing && document.pointerLockElement === canvas && weapons[activeWeapon].automatic) fire();
  for (const target of targets) {
    target.mesh.rotation.z += delta * 0.65;
    target.mesh.position.y =
      1.7 + Math.sin(performance.now() * 0.0015 + Number(target.id.at(-1))) * 0.12;
    if (!target.active && performance.now() >= target.respawnAt) {
      target.active = true;
      target.health = 100;
      target.mesh.visible = true;
      client.event("target_respawned", { targetId: target.id });
    }
  }
  gunGroup.position.x = Math.sin(weaponBob) * (moving || strafing ? 0.009 : 0);
  gunGroup.position.y = Math.abs(Math.cos(weaponBob)) * (moving || strafing ? 0.008 : 0);
  gunGroup.position.z *= 0.78;
  if (hitmarkerTimer && performance.now() > hitmarkerTimer) {
    required("hitmarker").classList.remove("visible");
    hitmarkerTimer = 0;
  }
  updateCamera();
  updateHud();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
};
animate();
