import assert from 'node:assert/strict';
import test from 'node:test';
import { dailyCountHeaders, updateChannel, updateIntervalMs } from '../src/core/updates';

test('the daily usage count: once per UTC day, version + os only, off when the setting is off', () => {
  const now = new Date('2026-11-21T23:59:00Z');
  const on = dailyCountHeaders({}, '2026-11-20', '0.1.1', 'linux', now);
  assert.deepEqual(on, { headers: { 'x-glslop-daily': '1', 'x-glslop-version': '0.1.1', 'x-glslop-os': 'linux' }, day: '2026-11-21' });
  assert.deepEqual(Object.keys(on.headers).sort(), ['x-glslop-daily', 'x-glslop-os', 'x-glslop-version'], 'nothing else is sent');
  assert.deepEqual(dailyCountHeaders({}, null, '0.1.1', 'windows', now).day, '2026-11-21', 'first ever check counts');
  assert.deepEqual(dailyCountHeaders({}, '2026-11-21', '0.1.1', 'windows', now), { headers: {}, day: null }, 'already counted today');
  assert.deepEqual(dailyCountHeaders({ dailyCount: false }, null, '0.1.1', 'windows', now), { headers: {}, day: null }, 'setting off');
  assert.deepEqual(dailyCountHeaders({}, null, '0.1.1', 'freebsd', now), { headers: {}, day: null }, 'unknown os: not sent');
  // the day rolls over at UTC midnight, not local midnight
  assert.equal(dailyCountHeaders({}, '2026-11-21', '0.1.1', 'macos', new Date('2026-11-22T00:00:01Z')).day, '2026-11-22');
});

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
