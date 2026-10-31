// Anti-flaky guard — pure response-quality check, no I/O.
//
// Some shared-pool upstreams answer HTTP 200 with a degenerate repetition
// loop ("OK.OK.OK.OK..." / one word repeated until it fills the answer). The
// refusal classifier does not see one: no marker vocabulary, no empty body, so
// a loop used to land as PATUH and the combo never tried the next model.
//
// Fail-open by construction: anything short, unusual or merely verbose is a
// good answer. Only a text where one short unit dominates the whole string is
// flagged.
//
// ponytail: text-level check only. The upstream also streams loops; catching
// those needs a mid-stream inspector, add one if a loop is ever measured
// escaping through the stream head gate.

const DEGENERATE_MIN_LENGTH = 24;
const DEGENERATE_COVERAGE = 0.8;
const DEGENERATE_MIN_REPEATS = 4;
const WORD_RUN_MIN = 8;

/**
 * A text is degenerate when one short unit (or one word) repeats until it
 * dominates the whole answer.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isDegenerateText(text) {
  const t = typeof text === "string" ? text.trim() : "";
  if (t.length < DEGENERATE_MIN_LENGTH) return false;

  for (let u = 1; u <= 16; u++) {
    const unit = t.slice(0, u);
    if (!unit.trim()) continue;
    let covered = 0;
    while (covered + u <= t.length && t.startsWith(unit, covered)) covered += u;
    const rest = t.slice(covered);
    const tailOk = rest.length > 0 && rest.length < u && unit.startsWith(rest);
    if ((covered === t.length || tailOk) && covered >= t.length * DEGENERATE_COVERAGE && covered / u >= DEGENERATE_MIN_REPEATS) {
      return true;
    }
  }

  const words = t.split(/\s+/);
  if (words.length >= 12) {
    let run = 1;
    let maxRun = 1;
    for (let i = 1; i < words.length; i++) {
      run = words[i] === words[i - 1] ? run + 1 : 1;
      if (run > maxRun) maxRun = run;
    }
    if (maxRun >= WORD_RUN_MIN && maxRun / words.length >= 0.5) return true;
  }

  return false;
}
