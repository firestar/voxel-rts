import { describe, it, expect } from 'vitest';
import {
  WinConditionHandler, MatchState,
  playerHqDestroyed, allEnemiesEliminated, lastTeamStanding,
} from '../src/sim/WinConditions';

function state(participants: string[], alive: string[], playerTeam = 'player'): MatchState {
  return {
    playerTeam: playerTeam as MatchState['playerTeam'],
    participants: participants as MatchState['participants'],
    teamsWithLiveHq: new Set(alive as unknown as MatchState['participants']),
    elapsedSeconds: 0,
  };
}

describe('win conditions', () => {
  it('player HQ destroyed → defeat, with the surviving enemy as winner', () => {
    const r = playerHqDestroyed(state(['player', 'enemy'], ['enemy']));
    expect(r).toEqual({ kind: 'defeat', winner: 'enemy', reason: 'player-hq-destroyed' });
  });

  it('all enemies eliminated while player stands → victory', () => {
    const r = allEnemiesEliminated(state(['player', 'enemy', 'enemy2'], ['player']));
    expect(r).toEqual({ kind: 'victory', winner: 'player', reason: 'all-enemies-eliminated' });
  });

  it('one enemy still alive → no victory yet', () => {
    expect(allEnemiesEliminated(state(['player', 'enemy', 'enemy2'], ['player', 'enemy2']))).toBeNull();
  });

  it('player gone is not a victory even if enemies also gone (defeat rule owns it)', () => {
    expect(allEnemiesEliminated(state(['player', 'enemy'], []))).toBeNull();
  });

  it('last team standing decides AI-vs-AI matches (no human seat involved)', () => {
    // player seat present but its team is one of several; enemy2 is the survivor.
    const r = lastTeamStanding(state(['player', 'enemy', 'enemy2'], ['enemy2']));
    expect(r).toEqual({ kind: 'defeat', winner: 'enemy2', reason: 'last-team-standing' });
  });

  it('last team standing → victory when the survivor IS the player', () => {
    const r = lastTeamStanding(state(['player', 'enemy'], ['player']));
    expect(r).toEqual({ kind: 'victory', winner: 'player', reason: 'last-team-standing' });
  });

  it('mutual elimination → draw', () => {
    const r = lastTeamStanding(state(['enemy', 'enemy2'], []));
    expect(r).toEqual({ kind: 'draw', winner: null, reason: 'mutual-elimination' });
  });

  it('player not a participant → player rules abstain, last-standing decides', () => {
    // Pure AI-vs-AI: no 'player' HQ ever existed.
    expect(playerHqDestroyed(state(['enemy', 'enemy2'], ['enemy']))).toBeNull();
    expect(lastTeamStanding(state(['enemy', 'enemy2'], ['enemy']))).toEqual(
      { kind: 'defeat', winner: 'enemy', reason: 'last-team-standing' });
  });

  describe('handler', () => {
    it('returns null while the match is in progress (≥2 teams alive)', () => {
      const h = new WinConditionHandler();
      expect(h.evaluate(state(['player', 'enemy'], ['player', 'enemy']))).toBeNull();
    });

    it('latches the first result and ignores later state', () => {
      const h = new WinConditionHandler();
      const first = h.evaluate(state(['player', 'enemy'], ['enemy'])); // player dies → defeat
      expect(first?.kind).toBe('defeat');
      // Even if the board "recovers", the latched result stands.
      expect(h.evaluate(state(['player', 'enemy'], ['player', 'enemy']))).toBe(first);
      expect(h.result).toBe(first);
    });

    it('default ruleset: player win in a 1v2 once both enemies fall', () => {
      const h = new WinConditionHandler();
      expect(h.evaluate(state(['player', 'enemy', 'enemy2'], ['player', 'enemy']))).toBeNull();
      const r = h.evaluate(state(['player', 'enemy', 'enemy2'], ['player']));
      expect(r).toEqual({ kind: 'victory', winner: 'player', reason: 'all-enemies-eliminated' });
    });

    it('reset() clears the latch for a new match', () => {
      const h = new WinConditionHandler();
      h.evaluate(state(['player', 'enemy'], ['enemy']));
      expect(h.result).not.toBeNull();
      h.reset();
      expect(h.result).toBeNull();
      expect(h.evaluate(state(['player', 'enemy'], ['player', 'enemy']))).toBeNull();
    });
  });
});
