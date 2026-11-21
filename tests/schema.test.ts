import assert from 'node:assert/strict';
import test from 'node:test';
import { argNames, argProblems } from '../src/studio/schema';

const SET_SOURCE = { type: 'object', properties: { isf: { type: 'string' }, title: { type: 'string' }, force: { type: 'boolean' } }, required: ['isf'] };

test('a wrong argument name is reported plainly instead of failing inside the tool', () => {
  assert.deepEqual(argProblems({ source: 'x' }, SET_SOURCE), ['isf is required']);
  assert.deepEqual(argNames(SET_SOURCE), ['isf', 'title', 'force']);
});

test('wrong types are reported, right ones pass, extra keys are allowed', () => {
  assert.deepEqual(argProblems({ isf: 42 }, SET_SOURCE), ['isf should be string, got integer']);
  assert.deepEqual(argProblems({ isf: 'x', force: 'yes' }, SET_SOURCE), ['force should be boolean, got string']);
  assert.deepEqual(argProblems({ isf: 'x', force: true, somethingElse: 1 }, SET_SOURCE), []);
});

test('numbers, arrays, nested objects and enums', () => {
  const s = {
    type: 'object',
    properties: {
      limit: { type: 'number' }, ids: { type: 'array', items: { type: 'string' } },
      sort: { type: 'string', enum: ['new', 'slop'] }, values: { type: 'object' },
    },
  };
  assert.deepEqual(argProblems({ limit: 3, ids: ['a', 'b'], sort: 'new', values: { speed: 2 } }, s), []);
  assert.deepEqual(argProblems({ limit: 2.5 }, s), [], 'a float is a number');
  assert.deepEqual(argProblems({ ids: ['a', 3] }, s), ['ids[1] should be string, got integer']);
  assert.deepEqual(argProblems({ sort: 'old' }, s), ['sort should be one of "new", "slop"']);
  assert.deepEqual(argProblems({ values: [1] }, s), ['values should be object, got array']);
});

test('no schema, or no args, never blocks a call', () => {
  assert.deepEqual(argProblems({ anything: 1 }, undefined), []);
  assert.deepEqual(argProblems(undefined, { type: 'object', properties: { x: { type: 'string' } } }), []);
  assert.deepEqual(argProblems(null, { type: 'object', required: ['x'] }), ['x is required']);
});
