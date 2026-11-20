// A copy of an ISF shader that no compiler cache can serve: the user's main() is renamed and wrapped
// by one that adds a unique, tiny constant to the output. The constant reaches the driver, so its
// shader cache misses. A comment or an unused #define does not work: ANGLE's translator drops both
// before the driver sees the code, and the driver then answers from its cache in a few milliseconds.
export function coldCopy(isf: string): string {
  const nonce = (1 + Math.random()).toFixed(9);
  const renamed = isf.replace(/\bvoid\s+main\s*\(\s*(void)?\s*\)/, 'void glslop_user_main()');
  if (renamed === isf) return isf; // no main() found: let the compile report that
  return `${renamed}
void main() {
  glslop_user_main();
  gl_FragColor += vec4(${nonce}e-12);
}
`;
}
