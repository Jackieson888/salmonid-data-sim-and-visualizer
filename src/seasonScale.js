// seasonScale.js
// The one date -> x-position mapping for the whole app — everything that
// draws against the season's x-axis must compute through this.
// Design rationale, invariants, gotchas: .claude/context/data.md
export function seasonFraction(i, last) {
  return last <= 0 ? 0 : i / last;
}
