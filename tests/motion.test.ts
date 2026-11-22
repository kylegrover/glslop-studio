import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMotion } from '../src/ui/motion';

test('motion: auto is full on Windows/macOS, calm on Linux, calm when the OS asks for reduced motion', () => {
  assert.equal(resolveMotion(undefined, 'windows', false), 'full');
  assert.equal(resolveMotion('auto', 'macos', false), 'full');
  assert.equal(resolveMotion(undefined, 'linux', false), 'calm');
  assert.equal(resolveMotion(undefined, 'windows', true), 'calm');
});

test('motion: an explicit setting wins, including over reduced motion; junk means auto', () => {
  assert.equal(resolveMotion('full', 'linux', true), 'full');
  assert.equal(resolveMotion('off', 'windows', false), 'off');
  assert.equal(resolveMotion('calm', 'macos', false), 'calm');
  assert.equal(resolveMotion('wild', 'windows', false), 'full');
});
