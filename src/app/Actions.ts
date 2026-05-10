// Per-unit and per-building action catalog. Each action carries a label, a
// keybind (KeyboardEvent.code), and a runner. The Game looks up the relevant
// list from the current selection, renders it as a side panel, and dispatches
// `pressed` keys through it.

import { Unit, UnitKind, WorkerFocus } from '../sim/Units';
import { Building, UPGRADE_OPTIONS, upgradeOptionById } from '../sim/Buildings';

/**
 * Hooks the Game exposes to actions so they can do things that require
 * touching state outside the unit / building (entering build mode, switching
 * the renderer's mode UI, etc.). Kept tiny on purpose — most actions just
 * mutate the unit / building directly.
 */
export interface ActionContext {
  enterBuildMode(): void;
  enterPlantMode(): void;
  cancelMode(): void;
  enterWaypointMode(stance: 'aggressive' | 'defensive'): void;
}

export interface UnitAction {
  id: string;
  label: string;
  /** KeyboardEvent.code, e.g. 'KeyH'. */
  key: string;
  /** Display string for the panel, e.g. 'H'. */
  keyLabel: string;
  /** Returns true when this action should appear for the given unit. */
  applicable: (u: Unit) => boolean;
  /** Runs against every selected unit the action applies to. */
  run: (units: Unit[], ctx: ActionContext) => void;
}

export interface BuildingAction {
  id: string;
  label: string;
  key: string;
  keyLabel: string;
  applicable: (b: Building) => boolean;
  run: (b: Building, ctx: ActionContext) => void;
}

/**
 * Order matches the panel display order. Each action's `applicable` decides
 * whether it shows for the active selection — actions whose filter rejects
 * every selected unit are hidden entirely.
 */
export const UNIT_ACTIONS: UnitAction[] = [
  {
    id: 'stop',
    label: 'Stop',
    key: 'KeyH',
    keyLabel: 'H',
    applicable: () => true,
    run: (units): void => {
      for (const u of units) {
        u.path = [];
        u.firingTarget = null;
        u.burstShotsRemaining = 0;
        u.burstShotTimer = 0;
      }
    },
  },
  {
    id: 'cancel-task',
    label: 'Cancel task',
    key: 'KeyX',
    keyLabel: 'X',
    applicable: (u) => u.kind === 'worker' || u.kind === 'dozer',
    run: (units): void => {
      for (const u of units) {
        if (u.kind === 'worker') u.task = { kind: 'idle' };
        if (u.kind === 'dozer') u.levelTargetY = null;
      }
    },
  },
  {
    id: 'plant',
    label: 'Plant sapling',
    key: 'KeyJ',
    keyLabel: 'J',
    applicable: (u) => u.kind === 'worker',
    run: (_units, ctx): void => ctx.enterPlantMode(),
  },
  // Worker focus buttons — restrict which resource type the worker auto-picks.
  ...(['auto', 'mine', 'chop', 'farm'] as WorkerFocus[]).map((focus) => {
    const meta: Record<WorkerFocus, { label: string; key: string; keyLabel: string }> = {
      auto:  { label: 'Focus: Auto',   key: 'KeyZ', keyLabel: 'Z' },
      mine:  { label: 'Focus: Mining', key: 'KeyM', keyLabel: 'M' },
      chop:  { label: 'Focus: Wood',   key: 'KeyL', keyLabel: 'L' },
      farm:  { label: 'Focus: Farming',key: 'KeyG', keyLabel: 'G' },
    };
    const m = meta[focus];
    return {
      id: `focus-${focus}`,
      label: m.label,
      key: m.key,
      keyLabel: m.keyLabel,
      applicable: (u: Unit) => u.kind === 'worker',
      run: (units: Unit[]): void => {
        for (const u of units) {
          if (u.kind !== 'worker') continue;
          u.workerFocus = focus;
          u.task = { kind: 'idle' };
        }
      },
    } satisfies UnitAction;
  }),
  {
    id: 'hold-fire',
    label: 'Hold fire',
    key: 'KeyF',
    keyLabel: 'F',
    applicable: (u) => u.weapon !== null,
    run: (units): void => {
      for (const u of units) {
        u.firingTarget = null;
        u.burstShotsRemaining = 0;
        u.burstShotTimer = 0;
      }
    },
  },
  {
    id: 'stance-aggressive',
    label: 'Stance: Aggressive',
    key: 'KeyV',
    keyLabel: 'V',
    applicable: (u) => u.weapon !== null,
    run: (units): void => {
      for (const u of units) {
        u.stance = 'aggressive';
        u.autoEngageCooldown = 0;
      }
    },
  },
  {
    id: 'stance-defensive',
    label: 'Stance: Defensive',
    key: 'KeyC',
    keyLabel: 'C',
    applicable: (u) => u.weapon !== null,
    run: (units): void => {
      for (const u of units) {
        u.stance = 'defensive';
        u.firingTarget = null;
      }
    },
  },
];

/**
 * Returns the unit actions that apply to AT LEAST ONE unit in the selection.
 * Each action's `run` will filter again, so a multi-unit selection only
 * affects the units it makes sense for.
 */
export function unitActionsFor(units: Unit[]): UnitAction[] {
  if (units.length === 0) return [];
  return UNIT_ACTIONS.filter(a => units.some(u => a.applicable(u)));
}

/** Per-kind keybind table for "Train X" actions on a barracks. */
const TRAIN_KEYS: Record<UnitKind, { key: string; keyLabel: string }> = {
  soldier:        { key: 'KeyQ', keyLabel: 'Q' },
  sniper:         { key: 'KeyA', keyLabel: 'A' },
  gunner:         { key: 'KeyS', keyLabel: 'S' },
  mortar_soldier: { key: 'KeyD', keyLabel: 'D' },
  rocket_soldier: { key: 'KeyF', keyLabel: 'F' },
  tank:           { key: 'KeyR', keyLabel: 'R' },
  tunneler:       { key: 'KeyT', keyLabel: 'T' },
  worm:           { key: 'KeyY', keyLabel: 'Y' },
  dozer:          { key: 'KeyU', keyLabel: 'U' },
  worker:         { key: 'KeyO', keyLabel: 'O' },
  rocket_truck:   { key: 'KeyN', keyLabel: 'N' },
  aa_vehicle:     { key: 'KeyI', keyLabel: 'I' },
  supply_truck:   { key: 'KeyM', keyLabel: 'M' },
  // Civilians aren't manually trained — they auto-spawn from neighborhoods.
  // Defined here only to satisfy the `Record<UnitKind, …>` shape; the
  // train-action filter never surfaces a button for `civilian` because
  // no building's `produces` list includes it.
  civilian:       { key: 'KeyM', keyLabel: 'M' },
};

function trainAction(kind: UnitKind): BuildingAction {
  const k = TRAIN_KEYS[kind];
  const label = `Train ${kind}`;
  return {
    id: `train-${kind}`,
    label,
    key: k.key,
    keyLabel: k.keyLabel,
    // Hide train buttons on buildings that haven't completed their initial
    // upgrade — the production tick refuses to act on the queue while a
    // building is pending/paused, so the buttons would otherwise appear to
    // do nothing. HQ stays operational during its own re-upgrade so we
    // never gate it (it doesn't `produces` units anyway).
    applicable: (b) => b.spec.produces.includes(kind) && b.upgradeState === 'enabled',
    run: (b): void => {
      b.trainQueue.push(kind);
    },
  };
}

export const BUILDING_ACTIONS: BuildingAction[] = [
  trainAction('soldier'),
  trainAction('sniper'),
  trainAction('gunner'),
  trainAction('mortar_soldier'),
  trainAction('rocket_soldier'),
  trainAction('tank'),
  trainAction('tunneler'),
  trainAction('worm'),
  trainAction('dozer'),
  trainAction('worker'),
  trainAction('rocket_truck'),
  trainAction('aa_vehicle'),
  {
    id: 'clear-queue',
    label: 'Clear queue',
    key: 'KeyX',
    keyLabel: 'X',
    applicable: (b) => b.spec.produces.length > 0,
    run: (b): void => { b.trainQueue.length = 0; },
  },
  {
    id: 'waypoint-aggressive',
    label: 'Set waypoint: Aggressive',
    key: 'KeyW',
    keyLabel: 'W',
    applicable: (b) => b.spec.produces.length > 0,
    run: (_b, ctx): void => { ctx.enterWaypointMode('aggressive'); },
  },
  {
    id: 'waypoint-defensive',
    label: 'Set waypoint: Defensive',
    key: 'KeyE',
    keyLabel: 'E',
    applicable: (b) => b.spec.produces.length > 0,
    run: (_b, ctx): void => { ctx.enterWaypointMode('defensive'); },
  },
  {
    id: 'clear-waypoint',
    label: 'Clear waypoint',
    key: 'KeyZ',
    keyLabel: 'Z',
    applicable: (b) => b.spec.produces.length > 0 && b.rallyPoint !== null,
    run: (b): void => { b.rallyPoint = null; },
  },
  // Per-option upgrade buttons — each entry expands `UPGRADE_OPTIONS` into a
  // BuildingAction. The button only appears when the option's `applicable`
  // filter accepts the building AND no upgrade is currently in progress.
  // Clicking sets the building's `activeUpgradeId` and flips it to pending;
  // the truck dispatcher takes over from there.
  ...UPGRADE_OPTIONS.map(opt => ({
    id: `upgrade-${opt.id}`,
    label: opt.label,
    key: `Key${opt.keyLabel.toUpperCase()}`,
    keyLabel: opt.keyLabel,
    applicable: (b: Building) => opt.applicable(b) && b.upgradeState !== 'pending',
    run: (b: Building): void => {
      b.activeUpgradeId = opt.id;
      // `initial` keeps the building disabled while pending; HQ upgrades
      // run with the building still operational. Either way the dispatcher
      // sees `pending` and starts deliveries.
      b.upgradeState = 'pending';
      b.upgradeStockpile.metals = 0;
      b.upgradeStockpile.wood = 0;
      // Re-arm the construction timer for the chosen upgrade. `initial` for
      // a freshly-placed building was set during `place()`; this runs on
      // RE-starting (after pause) or on HQ track upgrades.
      const seconds = opt.id === 'initial'
        ? (b.spec.constructionSeconds ?? 30)
        : (upgradeOptionById(opt.id)?.constructionSeconds ?? 30);
      b.constructionTimer = seconds;
      b.constructionTotal = seconds;
    },
  }) satisfies BuildingAction),
  {
    // Hard-cancel the active upgrade. Resources already delivered stay in
    // the building's `upgradeStockpile`; the recovery dispatcher then
    // ferries them back to HQ via `truck_recover_upgrade`. In-flight
    // upgrade trucks see `cancelled` on arrival and return with cargo
    // (refunded to the global pool). The active upgrade id is cleared so
    // the player can pick a different upgrade option immediately.
    id: 'upgrade-cancel',
    label: 'Cancel upgrade',
    key: 'KeyP',
    keyLabel: 'P',
    applicable: (b) => b.upgradeState === 'pending',
    run: (b): void => {
      b.upgradeState = 'cancelled';
      b.activeUpgradeId = null;
      b.constructionTimer = 0;
      b.constructionTotal = 0;
      // The actual voxel rollback (any blocks added during the upgrade)
      // happens in the building tick where `world` is in scope. We leave
      // the queue + before-materials intact so that path can run; the
      // cancelled-state branch in tick will rollback any stamped voxels
      // and then drop the queue.
    },
  },
];

export function buildingActionsFor(b: Building): BuildingAction[] {
  return BUILDING_ACTIONS.filter(a => a.applicable(b));
}
