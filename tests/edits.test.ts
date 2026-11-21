import assert from 'node:assert/strict';
import test from 'node:test';
import { autosaveAction, humanEdits, shaderFileName, unappliedEdits } from '../src/ui/edits';

test('unappliedEdits ignores line endings and nothing else', () => {
  assert.equal(unappliedEdits('a\nb', 'a\nb'), false);
  assert.equal(unappliedEdits('a\r\nb', 'a\nb'), false);
  assert.equal(unappliedEdits('a\nb ', 'a\nb'), true);
  assert.equal(unappliedEdits('', 'x'), true);
});

test('an agent may replace its own failed update, but not what a human typed', () => {
  const applied = 'void main(){}';
  // nothing typed
  assert.equal(humanEdits(applied, applied, null), false);
  // the human typed something and has not applied it
  assert.equal(humanEdits('void main(){ /* wip */ }', applied, null), true);
  // the agent's last update failed to compile: it is unapplied, but it is the agent's
  const broken = 'void main(){ nope }';
  assert.equal(humanEdits(broken, applied, broken), false);
  // ...until the human edits on top of it
  assert.equal(humanEdits(broken + ' // mine', applied, broken), true);
});

test('shaderFileName is always a plain .fs file name', () => {
  assert.equal(shaderFileName('scratch'), 'scratch.fs');
  assert.equal(shaderFileName('livecoder.fs'), 'livecoder.fs');
  assert.equal(shaderFileName('live coder (first person)'), 'live_coder_first_person_.fs');
  assert.equal(shaderFileName('../../etc/passwd'), '_.._etc_passwd.fs');
  assert.equal(shaderFileName('..'), 'shader.fs');
  assert.equal(shaderFileName(''), 'shader.fs');
  assert.ok(shaderFileName('x'.repeat(500)).length <= 83);
  for (const t of ['a/b', 'a\\b', 'C:\\x', '.hidden', '../../etc/passwd']) {
    assert.doesNotMatch(shaderFileName(t), /[\\/:]|^\./, t);
  }
});

test('an autosave is offered only when it differs from what is being opened', () => {
  assert.equal(autosaveAction('x', null), 'none');
  assert.equal(autosaveAction('x', ''), 'none');
  assert.equal(autosaveAction('x', '  \n'), 'none');
  assert.equal(autosaveAction('a\nb', 'a\r\nb'), 'none');
  assert.equal(autosaveAction('x', 'x edited'), 'offer');
});
