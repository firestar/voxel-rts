import type { Team } from './Units';

/**
 * Match-end / win-condition handling.
 *
 * The engine has no built-in notion of a match ending — historically the
 * AI-vs-AI harness re-implemented "an HQ was destroyed → someone won" on its
 * own. This module centralises that logic behind a small, extensible rule set
 * so the game (and the harness) share one source of truth, and so new win
 * conditions (timers, economic victory, objective control, …) can be added by
 * dropping another {@link WinCondition} into the list rather than threading
 * more checks through the tick loop.
 *
 * A {@link WinConditionHandler} evaluates its rules every sim tick against a
 * cheap {@link MatchState} snapshot and latches the first non-null result, so
 * the outcome is decided exactly once.
 */

export type MatchOutcomeKind = 'victory' | 'defeat' | 'draw';

export interface MatchResult {
  /** Outcome from the human player's point of view. AI-vs-AI matches still
   *  produce victory/defeat (relative to the nominal `player` seat) so the
   *  harness can read a single winner. */
  kind: MatchOutcomeKind;
  /** Winning team, or null for a draw (mutual elimination). */
  winner: Team | null;
  /** Which rule produced the result — surfaced in logs / telemetry. */
  reason: string;
}

/** Everything a win condition is allowed to look at. Kept deliberately small;
 *  extend it (resources, unit counts, captured objectives, …) as new
 *  conditions need more signal. */
export interface MatchState {
  /** The human player's team (still meaningful in AI-vs-AI: it's the seat the
   *  harness reports relative to). */
  playerTeam: Team;
  /** Every team that has fielded an HQ at any point this match. A team stays a
   *  participant after its HQ dies so elimination can be detected. */
  participants: Team[];
  /** Teams that currently have at least one live (non-destroyed) HQ. */
  teamsWithLiveHq: Set<Team>;
  /** Seconds of sim time elapsed — for future time-based conditions. */
  elapsedSeconds: number;
}

/** A single rule: return a result to END the match, or null to let play
 *  continue. Rules must be pure functions of {@link MatchState}. */
export type WinCondition = (s: MatchState) => MatchResult | null;

/** First participant other than `except` that still has a live HQ (the de-facto
 *  victor when one side is wiped out). Null when nobody else survives. */
function survivingOpponent(s: MatchState, except: Team): Team | null {
  for (const t of s.participants) {
    if (t !== except && s.teamsWithLiveHq.has(t)) return t;
  }
  return null;
}

/** Defeat when the human player's HQ is gone. */
export const playerHqDestroyed: WinCondition = (s) => {
  if (!s.participants.includes(s.playerTeam)) return null; // no player seat (pure AI-vs-AI)
  if (s.teamsWithLiveHq.has(s.playerTeam)) return null;
  return { kind: 'defeat', winner: survivingOpponent(s, s.playerTeam), reason: 'player-hq-destroyed' };
};

/** Victory when every enemy (non-player) participant has lost its HQ while the
 *  player still stands. */
export const allEnemiesEliminated: WinCondition = (s) => {
  const enemies = s.participants.filter(t => t !== s.playerTeam);
  if (enemies.length === 0) return null;
  if (!s.teamsWithLiveHq.has(s.playerTeam)) return null; // player gone → handled by defeat rule
  if (enemies.some(t => s.teamsWithLiveHq.has(t))) return null; // an enemy still alive
  return { kind: 'victory', winner: s.playerTeam, reason: 'all-enemies-eliminated' };
};

/** General fallback for any team layout (incl. AI-vs-AI with no human seat):
 *  the match ends once at most one team still has an HQ. */
export const lastTeamStanding: WinCondition = (s) => {
  if (s.participants.length < 2) return null;
  const alive = s.participants.filter(t => s.teamsWithLiveHq.has(t));
  if (alive.length === 1) {
    const winner = alive[0]!;
    return {
      kind: winner === s.playerTeam ? 'victory' : 'defeat',
      winner,
      reason: 'last-team-standing',
    };
  }
  if (alive.length === 0) return { kind: 'draw', winner: null, reason: 'mutual-elimination' };
  return null;
};

/** Default ruleset: player loss, player win, then the general last-standing
 *  fallback (which also covers AI-vs-AI). Order matters — the first non-null
 *  result wins, so the player-relative rules are checked before the generic
 *  one. Append future conditions here (or pass a custom list to the handler). */
export const DEFAULT_WIN_CONDITIONS: WinCondition[] = [
  playerHqDestroyed,
  allEnemiesEliminated,
  lastTeamStanding,
];

export class WinConditionHandler {
  private readonly conditions: WinCondition[];
  /** Latched result — set once when a rule first fires, then returned as-is. */
  result: MatchResult | null = null;

  constructor(conditions: WinCondition[] = DEFAULT_WIN_CONDITIONS) {
    this.conditions = conditions;
  }

  /** Evaluate the rules. Returns the (latched) {@link MatchResult} once the
   *  match has ended, or null while it's still in progress. Idempotent after
   *  the first non-null result. */
  evaluate(s: MatchState): MatchResult | null {
    if (this.result) return this.result;
    for (const c of this.conditions) {
      const r = c(s);
      if (r) { this.result = r; return r; }
    }
    return null;
  }

  /** Drop back to "in progress" (e.g. when a new match starts). */
  reset(): void {
    this.result = null;
  }
}
