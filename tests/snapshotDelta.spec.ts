import { describe, it, expect } from 'vitest';
import { applySnapshotDelta, type ServerSnapshot, type SnapshotDelta } from '../src/net/GameClient';

process.env.GAME_SERVER_TEST = '1';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gs = require('../game-server.cjs') as {
  snapshotDelta: (prev: ServerSnapshot | null, next: ServerSnapshot) => SnapshotDelta;
  deltaIsEmpty: (delta: SnapshotDelta) => boolean;
};

function makeSnap(overrides: Partial<ServerSnapshot> = {}): ServerSnapshot {
  return {
    tick: 1, rev: 1, voxelEditSeq: 0,
    entities: [], buildings: [], projectiles: [], resources: {},
    ...overrides,
  };
}

describe('snapshotDelta (server)', () => {
  it('null prev → all rows in *Changed', () => {
    const next = makeSnap({
      entities: [
        { id: 1, clientTag: 't1', kind: 'soldier', owner: 'red', x: 1, y: 0, z: 0, hp: 100, target: null, pathLen: 0 },
      ],
      buildings: [
        { id: 10, clientTag: null, kind: 'hq', owner: 'red',
          ox: 0, oz: 0, floorY: 0, cellsW: 6, cellsD: 6,
          upgradeState: 'enabled', hp: 1000, maxHp: 1000, trainQueueLen: 0, destroyed: false },
      ],
      resources: { red: { food: 10, metals: 20, wood: 30, popCap: 0 } },
    });
    const d = gs.snapshotDelta(null, next);
    expect(d.entitiesChanged?.length).toBe(1);
    expect(d.buildingsChanged?.length).toBe(1);
    expect(d.resourcesChanged?.red).toEqual({ food: 10, metals: 20, wood: 30, popCap: 0 });
    expect(d.entitiesRemoved).toBeUndefined();
    expect(gs.deltaIsEmpty(d)).toBe(false);
  });

  it('matching prev/next → empty delta', () => {
    const snap = makeSnap({
      entities: [{ id: 1, clientTag: 't', kind: 'soldier', owner: 'red', x: 0, y: 0, z: 0, hp: 100, target: null, pathLen: 0 }],
    });
    const d = gs.snapshotDelta(snap, snap);
    expect(gs.deltaIsEmpty(d)).toBe(true);
  });

  it('changed entity field → entitiesChanged carries the new row', () => {
    const a = makeSnap({
      entities: [{ id: 1, clientTag: 't', kind: 'soldier', owner: 'red', x: 0, y: 0, z: 0, hp: 100, target: null, pathLen: 0 }],
    });
    const b = makeSnap({
      tick: 2,
      entities: [{ id: 1, clientTag: 't', kind: 'soldier', owner: 'red', x: 1, y: 0, z: 0, hp: 100, target: null, pathLen: 0 }],
    });
    const d = gs.snapshotDelta(a, b);
    expect(d.entitiesChanged?.length).toBe(1);
    expect(d.entitiesChanged![0]!.x).toBe(1);
  });

  it('removed entity → entitiesRemoved by id', () => {
    const a = makeSnap({
      entities: [
        { id: 1, clientTag: 't1', kind: 'soldier', owner: 'red', x: 0, y: 0, z: 0, hp: 100, target: null, pathLen: 0 },
        { id: 2, clientTag: 't2', kind: 'soldier', owner: 'red', x: 0, y: 0, z: 0, hp: 100, target: null, pathLen: 0 },
      ],
    });
    const b = makeSnap({
      tick: 2,
      entities: [a.entities[0]!],
    });
    const d = gs.snapshotDelta(a, b);
    expect(d.entitiesRemoved).toEqual([2]);
    expect(d.entitiesChanged).toBeUndefined();
  });

  it('per-owner resources only flag changed owners', () => {
    const a = makeSnap({
      resources: {
        red: { food: 10, metals: 0, wood: 0, popCap: 0 },
        blue: { food: 5, metals: 0, wood: 0, popCap: 0 },
      },
    });
    const b = makeSnap({
      resources: {
        red: { food: 20, metals: 0, wood: 0, popCap: 0 }, // changed
        blue: { food: 5, metals: 0, wood: 0, popCap: 0 }, // same
      },
    });
    const d = gs.snapshotDelta(a, b);
    expect(d.resourcesChanged).toEqual({ red: { food: 20, metals: 0, wood: 0, popCap: 0 } });
  });
});

describe('applySnapshotDelta (browser)', () => {
  it('round-trips: prev + delta(prev, next) === next (entities/buildings/resources)', () => {
    const prev = makeSnap({
      entities: [{ id: 1, clientTag: 'a', kind: 'soldier', owner: 'red', x: 0, y: 0, z: 0, hp: 100, target: null, pathLen: 0 }],
      buildings: [{ id: 10, clientTag: null, kind: 'hq', owner: 'red', ox: 0, oz: 0, floorY: 0, cellsW: 6, cellsD: 6, upgradeState: 'enabled', hp: 1000, maxHp: 1000, trainQueueLen: 0, destroyed: false }],
      resources: { red: { food: 10, metals: 0, wood: 0, popCap: 0 } },
    });
    const next = makeSnap({
      tick: 2,
      entities: [
        { id: 1, clientTag: 'a', kind: 'soldier', owner: 'red', x: 5, y: 0, z: 0, hp: 90, target: null, pathLen: 0 }, // moved + lost hp
        { id: 2, clientTag: 'b', kind: 'tank', owner: 'red', x: 0, y: 0, z: 0, hp: 200, target: null, pathLen: 0 },   // added
      ],
      buildings: [], // hq removed
      resources: { red: { food: 12, metals: 0, wood: 0, popCap: 0 } },
    });
    const d = gs.snapshotDelta(prev, next);
    const merged = applySnapshotDelta(prev, d);
    expect(merged.entities.length).toBe(2);
    expect(merged.entities.find(e => e.id === 1)!.x).toBe(5);
    expect(merged.entities.find(e => e.id === 1)!.hp).toBe(90);
    expect(merged.entities.find(e => e.id === 2)).toBeDefined();
    expect(merged.buildings ?? []).toEqual([]);
    expect(merged.resources!.red.food).toBe(12);
  });

  it('empty delta leaves the snapshot unchanged structurally', () => {
    const prev = makeSnap({
      entities: [{ id: 1, clientTag: 'a', kind: 'soldier', owner: 'red', x: 0, y: 0, z: 0, hp: 100, target: null, pathLen: 0 }],
    });
    const merged = applySnapshotDelta(prev, { tick: 99, rev: 99 });
    expect(merged.entities.length).toBe(1);
    expect(merged.entities[0]!.id).toBe(1);
  });

  it('null base + delta with adds → all rows materialise', () => {
    const merged = applySnapshotDelta(null, {
      tick: 5, rev: 5,
      entitiesChanged: [
        { id: 1, clientTag: 't', kind: 'soldier', owner: 'red', x: 0, y: 0, z: 0, hp: 100, target: null, pathLen: 0 },
      ],
      resourcesChanged: { red: { food: 50, metals: 0, wood: 0, popCap: 0 } },
    });
    expect(merged.entities.length).toBe(1);
    expect(merged.resources!.red.food).toBe(50);
  });
});
