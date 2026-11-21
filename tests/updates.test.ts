import assert from 'node:assert/strict';
import test from 'node:test';
import { updateChannel, updateIntervalMs } from '../src/core/updates';

test('a stable build follows stable; a beta build follows betas; the setting overrides both', () => {
  assert.equal(updateChannel({}, '0.1.0'), 'stable');
  assert.equal(updateChannel({}, '0.2.0-beta.1'), 'beta');
  assert.equal(updateChannel({ betaUpdates: true }, '0.1.0'), 'beta');
  assert.equal(updateChannel({ betaUpdates: false }, '0.2.0-beta.1'), 'stable');
  // anything but a real boolean is "not set"
  for (const odd of ['true', 1, null, undefined]) assert.equal(updateChannel({ betaUpdates: odd }, '0.1.0'), 'stable', String(odd));
});

test('the update interval defaults to 6 hours and stays between 1 hour and a week', () => {
  const h = 3_600_000;
  assert.equal(updateIntervalMs({}), 6 * h);
  assert.equal(updateIntervalMs({ updateCheckHours: 12 }), 12 * h);
  assert.equal(updateIntervalMs({ updateCheckHours: 0.01 }), 1 * h);
  assert.equal(updateIntervalMs({ updateCheckHours: 100000 }), 168 * h);
  for (const odd of [0, -3, 'soon', null, NaN]) assert.equal(updateIntervalMs({ updateCheckHours: odd }), 6 * h, String(odd));
});
