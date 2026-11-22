import assert from 'node:assert/strict';
import test from 'node:test';
import { parseISF, plainSpaces } from '../packages/core/src/parse';

const body = '\nvoid main() { gl_FragColor = vec4(1.0); }';

test('a header with no-break spaces between tokens parses (pasted from a web page or chat)', () => {
  const src = `/*{\u00A0"DESCRIPTION":\u00A0"x",\n\u00A0\u00A0"INPUTS": [ {\u202F"NAME": "gain", "TYPE": "float" } ]\u3000}*/${body}`;
  const r = parseISF(src);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  if (!r.ok) return;
  assert.equal(r.isf.inputs[0]?.NAME, 'gain');
  assert.equal(r.isf.body, body);
  assert.equal(r.isf.raw, src, 'raw source is kept exactly as written');
});

test('odd spaces inside strings are content and stay', () => {
  const r = parseISF(`/*{ "DESCRIPTION": "a\u00A0b \\"q\u00A0\\" c", "CREDIT": "\\\\" ,\u00A0"CATEGORIES": [] }*/${body}`);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  if (!r.ok) return;
  assert.equal(r.isf.header.DESCRIPTION, 'a\u00A0b "q\u00A0" c');
  assert.equal(r.isf.header.CREDIT, '\\');
});

test('plainSpaces leaves valid JSON untouched', () => {
  const j = '{ "a": [1, 2], "b": "x\\"y" }';
  assert.equal(plainSpaces(j), j);
});

test('JSON that is invalid for other reasons is still rejected', () => {
  const r = parseISF(`/*{\u00A0"a": 1,, }*/${body}`);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /^ISF JSON header is not valid JSON/);
});
