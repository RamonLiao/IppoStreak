// Friendly messages for `league.move` abort codes. The contract is the source of truth for
// what can fail a place_pick / settle_pick; codes mirror the `const E*: u64` block in
// league.move. We map ONLY when the failure clearly originated in the league module — a
// predict/manager abort can share a numeric code, and mislabelling it would mislead the user.
const LEAGUE_ABORTS: Record<number, string> = {
  2: 'This market just closed — pick a different one.',
  3: 'You already have a pick on this market.',
  4: "Not expired yet — can't settle.",
  5: 'This pick is already settled.',
  9: 'The league is paused right now.',
  11: "The oracle hasn't settled this market yet.",
  12: 'No player profile found — finish onboarding first.',
  13: 'That question no longer exists.',
  16: 'Oracle/market mismatch — refresh and try again.',
  17: 'Trading-account mismatch.',
  18: 'Stake came out to zero — try a larger amount.',
  22: 'Price moved past your limit — raise the amount or retry.',
  23: 'This oracle is no longer active.',
};

// Map any thrown value (Error, string, or a stringified FailedTransaction status) to a
// human-readable message, upgrading a recognised league abort to its friendly text.
export function toMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : safeStringify(e);
  const code = parseAbortCode(raw);
  // Require the rendering to reference the league module before claiming a league message —
  // otherwise a predict-side abort with the same code would be mis-described.
  if (code != null && /league/i.test(raw) && LEAGUE_ABORTS[code]) return LEAGUE_ABORTS[code];
  return raw;
}

function parseAbortCode(s: string): number | null {
  const m =
    s.match(/MoveAbort[\s\S]*?,\s*(\d+)\s*\)/) ||
    s.match(/abort(?:ed)?(?:\s+code)?[:\s]+(\d+)/i) ||
    s.match(/"?(?:error_code|code)"?\s*[:=]\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

function safeStringify(e: unknown): string {
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
