import { describe, it, expect } from 'vitest';
import {
  interpolateSnapshots,
  findBracket,
  GameClient,
  type ServerSnapshot,
  type ServerEntity,
  type ServerProjectile,
} from '../src/net/GameClient';

function entity(id: number, x: number, y: number, z: number, hp = 100): ServerEntity {
  return { id, clientTag: `t-${id}`, kind: 'soldier', owner: 'red', x, y, z, hp, target: null, pathLen: 0 };
}

function projectile(id: number, x: number, y: number, z: number): ServerProjectile {
  return {
    id, clientTag: `p-${id}`, kind: 'bullet_5_56mm', owner: 'red',
    x, y, z, vx: 0, vy: 0, vz: 0, age: 0, ownerId: -1,
  };
}

function makeSnap(entities: ServerEntity[], projectiles: ServerProjectile[] = []): ServerSnapshot {
  return {
    tick: 0, rev: 0, voxelEditSeq: 0,
    entities, projectiles, buildings: [], resources: {},
  };
}

describe('interpolateSnapshots (pure)', () => {
  it('lerps entity positions at the midpoint', () => {
    const a = makeSnap([entity(1, 0, 0, 0)]);
    const b = makeSnap([entity(1, 10, 0, 20)]);
    const mid = interpolateSnapshots(a, b, 0.5);
    expect(mid.entities[0]!.x).toBeCloseTo(5);
    expect(mid.entities[0]!.z).toBeCloseTo(10);
  });

  it('alpha=0 returns a position', () => {
    const a = makeSnap([entity(1, 0, 0, 0)]);
    const b = makeSnap([entity(1, 100, 0, 0)]);
    const r = interpolateSnapshots(a, b, 0);
    expect(r.entities[0]!.x).toBe(0);
  });

  it('alpha=1 returns b position', () => {
    const a = makeSnap([entity(1, 0, 0, 0)]);
    const b = makeSnap([entity(1, 100, 0, 0)]);
    const r = interpolateSnapshots(a, b, 1);
    expect(r.entities[0]!.x).toBe(100);
  });

  it('clamps alpha into [0, 1]', () => {
    const a = makeSnap([entity(1, 0, 0, 0)]);
    const b = makeSnap([entity(1, 100, 0, 0)]);
    expect(interpolateSnapshots(a, b, -1).entities[0]!.x).toBe(0);
    expect(interpolateSnapshots(a, b, 5).entities[0]!.x).toBe(100);
  });

  it('entities only in b take b position (no extrapolation)', () => {
    const a = makeSnap([entity(1, 0, 0, 0)]);
    const b = makeSnap([
      entity(1, 10, 0, 0),
      entity(2, 50, 0, 0),  // new
    ]);
    const r = interpolateSnapshots(a, b, 0.5);
    expect(r.entities.length).toBe(2);
    expect(r.entities.find(e => e.id === 1)!.x).toBeCloseTo(5);
    expect(r.entities.find(e => e.id === 2)!.x).toBe(50);
  });

  it('entities only in a are dropped (b is the canonical roster)', () => {
    const a = makeSnap([entity(1, 0, 0, 0), entity(2, 0, 0, 0)]);
    const b = makeSnap([entity(1, 10, 0, 0)]);
    const r = interpolateSnapshots(a, b, 0.5);
    expect(r.entities.length).toBe(1);
    expect(r.entities[0]!.id).toBe(1);
  });

  it('projectiles lerp the same way', () => {
    const a = makeSnap([], [projectile(1, 0, 0, 0)]);
    const b = makeSnap([], [projectile(1, 80, 0, 0)]);
    const r = interpolateSnapshots(a, b, 0.25);
    expect(r.projectiles![0]!.x).toBeCloseTo(20);
  });

  it('hp / target take b values verbatim (no smearing)', () => {
    const a = makeSnap([entity(1, 0, 0, 0, 100)]);
    const b = makeSnap([{ ...entity(1, 10, 0, 0, 50), target: { x: 5, z: 5 } }]);
    const r = interpolateSnapshots(a, b, 0.5);
    expect(r.entities[0]!.hp).toBe(50);
    expect(r.entities[0]!.target).toEqual({ x: 5, z: 5 });
  });
});

describe('findBracket (pure)', () => {
  const buf = [
    { receivedAt: 100, snap: makeSnap([entity(1, 0, 0, 0)]) },
    { receivedAt: 200, snap: makeSnap([entity(1, 10, 0, 0)]) },
    { receivedAt: 300, snap: makeSnap([entity(1, 20, 0, 0)]) },
  ];

  it('mid-bracket → correct alpha', () => {
    const r = findBracket(buf, 150);
    expect(r).not.toBeNull();
    expect(r!.alpha).toBeCloseTo(0.5);
    expect(r!.a.snap.entities[0]!.x).toBe(0);
    expect(r!.b.snap.entities[0]!.x).toBe(10);
  });

  it('exact boundary lands on the bracket containing it', () => {
    // 200 sits at the close of the [100, 200] segment — the search
    // walks forward and returns that bracket with alpha=1, which
    // means the interpolated position equals `b`'s. Either way the
    // result resolves to the buffer entry at 200.
    const r = findBracket(buf, 200);
    expect(r).not.toBeNull();
    expect(r!.alpha).toBe(1);
    expect(r!.a.receivedAt).toBe(100);
    expect(r!.b.receivedAt).toBe(200);
  });

  it('before the buffer → clamps to first entry', () => {
    const r = findBracket(buf, 50);
    expect(r!.a).toBe(buf[0]);
    expect(r!.b).toBe(buf[0]);
    expect(r!.alpha).toBe(0);
  });

  it('after the buffer → clamps to last entry', () => {
    const r = findBracket(buf, 1000);
    expect(r!.a).toBe(buf[buf.length - 1]);
    expect(r!.b).toBe(buf[buf.length - 1]);
  });

  it('empty buffer → null', () => {
    expect(findBracket([], 100)).toBeNull();
  });
});

describe('GameClient interp API', () => {
  it('interpolatedAt produces lerped positions across the buffer', () => {
    const c = new GameClient();
    c._pushSnapshotForTest(makeSnap([entity(1, 0, 0, 0)]), 1000);
    c._pushSnapshotForTest(makeSnap([entity(1, 10, 0, 0)]), 1100);
    c._pushSnapshotForTest(makeSnap([entity(1, 20, 0, 0)]), 1200);
    expect(c.interpolatedAt(1050)!.entities[0]!.x).toBeCloseTo(5);
    expect(c.interpolatedAt(1150)!.entities[0]!.x).toBeCloseTo(15);
  });

  it('interpolatedAt before the first entry returns the earliest snapshot', () => {
    const c = new GameClient();
    c._pushSnapshotForTest(makeSnap([entity(1, 0, 0, 0)]), 1000);
    c._pushSnapshotForTest(makeSnap([entity(1, 10, 0, 0)]), 1100);
    expect(c.interpolatedAt(500)!.entities[0]!.x).toBe(0);
  });

  it('empty buffer → null', () => {
    const c = new GameClient();
    expect(c.interpolatedAt(0)).toBeNull();
    expect(c.interpolatedSnapshot()).toBeNull();
  });

  it('buffer caps at INTERP_BUFFER_SIZE', () => {
    const c = new GameClient();
    for (let i = 0; i < 30; i++) {
      c._pushSnapshotForTest(makeSnap([entity(1, i, 0, 0)]), 1000 + i);
    }
    // Newest entry still queryable.
    const newest = c.interpolatedAt(1029);
    expect(newest!.entities[0]!.x).toBe(29);
    // Oldest in-buffer is 1010 (kept 20 newest), so a query for 1000
    // clamps to whichever survived — assert it's at least 10.
    const clamped = c.interpolatedAt(0);
    expect(clamped!.entities[0]!.x).toBeGreaterThanOrEqual(10);
  });
});
