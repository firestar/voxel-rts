// Per-unit and per-building action catalog. Each action carries a label, a
// keybind (KeyboardEvent.code), and a runner. The Game looks up the relevant
// list from the current selection, renders it as a side panel, and dispatches
// `pressed` keys through it.

import { Unit, UnitKind } from '../sim/Units';
import { Building } from '../sim/Buildings';

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
  soldier:      { key: 'KeyQ', keyLabel: 'Q' },
  tank:         { key: 'KeyR', keyLabel: 'R' },
  tunneler:     { key: 'KeyT', keyLabel: 'T' },
  worm:         { key: 'KeyY', keyLabel: 'Y' },
  dozer:        { key: 'KeyU', keyLabel: 'U' },
  worker:       { key: 'KeyO', keyLabel: 'O' },
  rocket_truck: { key: 'KeyN', keyLabel: 'N' },
};

function trainAction(kind: UnitKind): BuildingAction {
  const k = TRAIN_KEYS[kind];
  const label = `Train ${kind}`;
  return {
    id: `train-${kind}`,
    label,
    key: k.key,
    keyLabel: k.keyLabel,
    applicable: (b) => b.spec.produces.includes(kind),
    run: (b): void => {
      b.trainQueue.push(kind);
    },
  };
}

export const BUILDING_ACTIONS: BuildingAction[] = [
  trainAction('soldier'),
  trainAction('tank'),
  trainAction('tunneler'),
  trainAction('worm'),
  trainAction('dozer'),
  trainAction('worker'),
  trainAction('rocket_truck'),
  {
    id: 'clear-queue',
    label: 'Clear queue',
    key: 'KeyX',
    keyLabel: 'X',
    applicable: (b) => b.spec.produces.length > 0,
    run: (b): void => { b.trainQueue.length = 0; },
  },
];

export function buildingActionsFor(b: Building): BuildingAction[] {
  return BUILDING_ACTIONS.filter(a => a.applicable(b));
}
