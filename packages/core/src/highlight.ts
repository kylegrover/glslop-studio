// Tiny, dependency-free ISF highlighter. An ISF doc is a leading /*{ ...JSON... }*/
// header followed by a GLSL body, so we colour the header as JSON and the rest as GLSL.
// Everything is HTML-escaped before any markup is added, so the output is safe to drop
// into {@html} / set:html even though the source is user-authored.

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const span = (cls: string, text: string): string => `<span class="${cls}">${esc(text)}</span>`;

// ---- JSON (the ISF header) -------------------------------------------------
function highlightJson(s: string): string {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    const c2 = s[i + 1] ?? '';
    if (c === '"') {
      // consume a (possibly escaped) string
      let j = i + 1;
      while (j < n) {
        if (s[j] === '\\') {
          j += 2;
          continue;
        }
        if (s[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      const str = s.slice(i, j);
      // a string is a "key" when the next non-space char is a colon
      let k = j;
      while (k < n && /\s/.test(s[k])) k++;
      out += span(s[k] === ':' ? 'tk-key' : 'tk-str', str);
      i = j;
      continue;
    }
    if (/\d/.test(c) || (c === '-' && /\d/.test(c2)) || (c === '.' && /\d/.test(c2))) {
      const m = s.slice(i).match(/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
      if (m) {
        out += span('tk-num', m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(c)) {
      const w = s.slice(i).match(/^[A-Za-z_]\w*/)![0];
      out += w === 'true' || w === 'false' || w === 'null' ? span('tk-bool', w) : esc(w);
      i += w.length;
      continue;
    }
    if ('{}[],:'.includes(c)) {
      out += span('tk-punct', c);
      i++;
      continue;
    }
    out += esc(c);
    i++;
  }
  return out;
}

// ---- GLSL (the shader body) ------------------------------------------------
const GLSL_TYPE = new Set([
  'void', 'float', 'int', 'bool', 'vec2', 'vec3', 'vec4', 'mat2', 'mat3', 'mat4',
  'ivec2', 'ivec3', 'ivec4', 'bvec2', 'bvec3', 'bvec4', 'sampler2D', 'samplerCube',
]);
const GLSL_KW = new Set([
  'if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue', 'discard',
  'in', 'out', 'inout', 'const', 'uniform', 'varying', 'attribute', 'precision',
  'highp', 'mediump', 'lowp', 'struct', 'true', 'false',
]);
const GLSL_BUILTIN = new Set([
  'RENDERSIZE', 'TIME', 'TIMEDELTA', 'FRAMEINDEX', 'DATE', 'PASSINDEX', 'PI',
]);

function highlightGlsl(s: string): string {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    const c2 = s[i + 1] ?? '';
    // line comment
    if (c === '/' && c2 === '/') {
      const nl = s.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      out += span('tk-comment', s.slice(i, end));
      i = end;
      continue;
    }
    // block comment
    if (c === '/' && c2 === '*') {
      const close = s.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      out += span('tk-comment', s.slice(i, end));
      i = end;
      continue;
    }
    // preprocessor directive at line start (#define, #ifdef, …)
    if (c === '#' && (i === 0 || s[i - 1] === '\n')) {
      const nl = s.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      out += span('tk-pp', s.slice(i, end));
      i = end;
      continue;
    }
    // number (incl. trailing GLSL float suffix)
    if (/\d/.test(c) || (c === '.' && /\d/.test(c2))) {
      const m = s.slice(i).match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fF]?/);
      if (m) {
        out += span('tk-num', m[0]);
        i += m[0].length;
        continue;
      }
    }
    // identifier / keyword / type / builtin / function
    if (/[A-Za-z_]/.test(c)) {
      const w = s.slice(i).match(/^[A-Za-z_]\w*/)![0];
      const k = i + w.length;
      let cls = '';
      if (GLSL_TYPE.has(w)) cls = 'tk-type';
      else if (GLSL_KW.has(w)) cls = 'tk-kw';
      else if (GLSL_BUILTIN.has(w) || /^(IMG_|isf_|gl_)/.test(w)) cls = 'tk-builtin';
      else {
        let p = k;
        while (p < n && /[ \t]/.test(s[p])) p++;
        if (s[p] === '(') cls = 'tk-fn';
      }
      out += cls ? span(cls, w) : esc(w);
      i = k;
      continue;
    }
    out += esc(c);
    i++;
  }
  return out;
}

/** Highlight an ISF document: JSON header in a /* *​/ comment, then GLSL. */
export function highlightIsf(src: string): string {
  // A textarea normalizes CRLF/CR to LF, while assigning highlighted markup via
  // innerHTML can preserve the CR and LF as two separate line breaks. Normalize
  // here so the painted <pre> always has the same line count and scroll height as
  // the textarea layered over it (notably for shader files authored on Windows).
  src = src.replace(/\r\n?/g, '\n');
  const m = src.match(/^(\s*)\/\*([\s\S]*?)\*\//);
  if (m) {
    const [, lead, inner] = m;
    const body = src.slice(m[0].length);
    return (
      esc(lead) +
      '<span class="tk-comment">/*</span>' +
      highlightJson(inner) +
      '<span class="tk-comment">*/</span>' +
      highlightGlsl(body)
    );
  }
  return highlightGlsl(src);
}
