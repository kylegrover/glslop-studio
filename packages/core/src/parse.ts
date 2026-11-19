import type { ISFInput, ISFPass, ParsedISF } from './types';

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
    header = JSON.parse(m[1]);
  } catch (e) {
    return { ok: false, error: 'ISF JSON header is not valid JSON: ' + (e as Error).message };
  }
  const body = src.slice(m[0].length);
  const inputs: ISFInput[] = Array.isArray(header.INPUTS) ? header.INPUTS : [];
  const passes: ISFPass[] = Array.isArray(header.PASSES) ? header.PASSES : [];
  return { ok: true, isf: { header, body, raw: src, inputs, passes } };
}
