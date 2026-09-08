// The one date -> x-position mapping used across the app.
export function seasonFraction(i, last) {
  return last <= 0 ? 0 : i / last;
}
