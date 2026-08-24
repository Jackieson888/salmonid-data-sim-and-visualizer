// seasonScale.js
// The one date -> x-position mapping for the whole app. The bar's own season
// chart and month axis (main.js) and every figure in the plates drawer
// (plates.js) all have to agree on where a given record index sits along the
// x-axis, or the timeline's cursor reads against one curve and lies about the
// rest — see the alignment note in index.html and style.css's #season-chart/
// #timeline-axis margin rule. This function is the single source of truth
// for that: everything else just picks its own output width.
export function seasonFraction(i, last) {
  return last <= 0 ? 0 : i / last;
}
