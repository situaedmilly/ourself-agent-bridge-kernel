import { openSync, closeSync, fstatSync, readSync, realpathSync, constants } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { SECRET_PATH } from './execution-classes.js';

const MAX_BYTES = 16 * 1024 * 1024;

// Trusted operator binding, not a new authority source. A successful check
// establishes correspondence only at observation time; it is not an OS lock.
export function createExecutionPreimage(root, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(k => !['target', 'sha256', 'expiresAt'].includes(k))
      || typeof input.target !== 'string' || !input.target || isAbsolute(input.target)
      || SECRET_PATH.test(input.target) || !/^[a-f0-9]{64}$/.test(input.sha256 ?? '')) {
    throw new TypeError('invalid execution preimage');
  }
  const absolute = resolve(root, input.target);
  const target = relative(root, absolute);
  if (target !== input.target || target === '..' || target.startsWith('..' + sep) || !target) {
    throw new TypeError('execution preimage must name one normalized relative target');
  }
  const expires = input.expiresAt === undefined ? null : Date.parse(input.expiresAt);
  if (expires !== null && (!Number.isFinite(expires) || typeof input.expiresAt !== 'string')) {
    throw new TypeError('invalid execution preimage expiry');
  }
  const binding = Object.freeze({ target, sha256: input.sha256,
    ...(expires === null ? {} : { expiresAt: new Date(expires).toISOString() }) });
  function check(plan) {
    let fd;
    try {
      if (plan.executable !== 'git' || plan.argv?.length !== 3
          || plan.argv[0] !== 'add' || plan.argv[1] !== '--' || plan.argv[2] !== target) return false;
      if (expires !== null && Date.now() >= expires) return false;
      const realRoot = realpathSync(root);
      if (realRoot !== plan.cwd) return false;
      const expected = resolve(realRoot, target);
      if (realpathSync(absolute) !== expected || SECRET_PATH.test(expected)) return false;
      fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.size > BigInt(MAX_BYTES)) return false;
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(65536);
      let total = 0;
      for (;;) {
        const n = readSync(fd, buffer, 0, buffer.length, null);
        if (!n) break;
        total += n;
        if (total > MAX_BYTES) return false;
        hash.update(buffer.subarray(0, n));
      }
      const after = fstatSync(fd, { bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
          || realpathSync(absolute) !== expected) return false;
      return hash.digest('hex') === binding.sha256 && (expires === null || Date.now() < expires);
    } catch { return false; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return { binding, check };
}
