import type { ISFInput, ISFPass, ParsedISF } from './types.js';

export type ParseResult =
  | { ok: true; isf: ParsedISF }
  | { ok: false; error: string };

// ISF = a leading /*{ ...JSON... }*/ comment header, then the GLSL body.
export function parseISF(src: string): ParseResult {
  // `\s*` is intentional: ECMAScript treats a UTF-8 BOM as whitespace, so Windows-authored ISF
  // keeps working. Anchoring prevents a stray token, a comment, or a whole helper function above
  // the header from being silently discarded when we slice the GLSL body below.
  const m = src.match(/^\s*\/\*\s*(\{[\s\S]*?\})\s*\*\//);
  if (!m) {
    // Be precise about a common near-miss: the header exists, but it is not the first content.
    // The anchor above must stay strict; accepting this match would reintroduce source truncation.
    if (/\/\*\s*\{[\s\S]*?\}\s*\*\//.test(src)) {
      return { ok: false, error: 'ISF JSON header must be the first thing in the file (apart from whitespace).' };
    }
    return { ok: false, error: 'No ISF JSON header found. Expected a leading /*{ ... }*/ block.' };
  }
  let header: any;
  try {
    header = JSON.parse(plainSpaces(m[1]));
  } catch (e) {
    return { ok: false, error: 'ISF JSON header is not valid JSON: ' + (e as Error).message };
  }
  const body = src.slice(m[0].length);
  const inputs: ISFInput[] = Array.isArray(header.INPUTS) ? header.INPUTS : [];
  const passes: ISFPass[] = Array.isArray(header.PASSES) ? header.PASSES : [];
  return { ok: true, isf: { header, body, raw: src, inputs, passes } };
}

// Unicode spaces JSON doesn't allow between tokens: no-break, figure, narrow no-break, BOM, and
// the other Zs spaces. They arrive when a header is pasted from a web page, chat or word processor
// and look exactly like spaces. Outside string literals they can only be layout, so they become
// plain spaces; inside strings they are content and stay. Valid JSON comes back unchanged.
const ODD_SPACE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/;
export function plainSpaces(json: string): string {
  if (!ODD_SPACE.test(json)) return json;
  let out = '', inStr = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += json[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') { inStr = true; out += c; }
    else out += ODD_SPACE.test(c) ? ' ' : c;
  }
  return out;
}
