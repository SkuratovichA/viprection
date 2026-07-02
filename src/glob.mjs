/**
 * Tiny dependency-free glob matcher for gitignore-style path globs.
 * Supports: `**` (any path incl. /), `*` (any non-/ run), `?` (single non-/),
 * and literal segments. Enough for uiGlobs like "packages/client/**" and
 * "packages/*​/schema.graphql". Not a full minimatch (no braces/negation).
 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // ** → any chars including /
        // consume a following slash so "a/**/b" also matches "a/b"
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else if (c === '/') {
      re += '/';
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

const cache = new Map();
export function globMatch(glob, path) {
  let re = cache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    cache.set(glob, re);
  }
  return re.test(path);
}
