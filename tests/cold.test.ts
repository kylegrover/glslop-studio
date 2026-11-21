import assert from 'node:assert/strict';
import test from 'node:test';
import { coldCopy } from '../src/engine/cold';
import { joinPath } from '../src/studio/host';

const ISF = '/*{ "INPUTS": [] }*/\nvoid main() {\n  gl_FragColor = vec4(1.0);\n}\n';

test('coldCopy wraps main() so the output changes, differently every time', () => {
  const a = coldCopy(ISF), b = coldCopy(ISF);
  assert.notEqual(a, b, 'two copies must differ or the driver cache serves the second');
  for (const c of [a, b]) {
    assert.match(c, /void glslop_user_main\(\)/);
    assert.equal(c.match(/void\s+main\s*\(/g)?.length, 1, 'exactly one main()');
    assert.match(c, /gl_FragColor \+= vec4\(1\.\d{9}e-12\);/, 'the nonce reaches the output (a comment or #define would be dropped)');
    assert.ok(c.startsWith('/*{ "INPUTS": [] }*/'), 'the ISF header stays first');
  }
});

test('coldCopy handles main(void) and leaves a shader without main() alone', () => {
  assert.match(coldCopy('void main(void){ gl_FragColor = vec4(0.); }'), /void glslop_user_main\(\)\{/);
  const noMain = 'float f(){ return 1.0; }';
  assert.equal(coldCopy(noMain), noMain);
  // a function merely named like main must not be renamed
  assert.equal(coldCopy('void domain(){}'), 'void domain(){}');
});

test('joinPath uses the separator of the first part and trims doubled ones', () => {
  assert.equal(joinPath('C:\\Users\\k\\.glslop-studio', 'mods', 'a.js'), 'C:\\Users\\k\\.glslop-studio\\mods\\a.js');
  assert.equal(joinPath('/home/k/.glslop-studio/', '/mods/', 'a.js'), '/home/k/.glslop-studio/mods/a.js');
  assert.equal(joinPath('/a', '', 'b'), '/a/b');
});
