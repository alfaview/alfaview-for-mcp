// The entry of the eval: `npm run eval -- [options]` (README.md of this folder).
//
// The fake API of the tests (test/fake-api/server.ts) imports test/helpers/spec.ts, which registers
// hooks of node:test. This module first sends that import to quiet-spec.ts, and only then loads the
// rest of the eval.
import { registerHooks } from 'node:module';

const SPEC = new URL('../test/helpers/spec.ts', import.meta.url).href;
const QUIET_SPEC = new URL('./quiet-spec.ts', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return resolved.url === SPEC ? { ...resolved, url: QUIET_SPEC } : resolved;
  },
});

const { main } = await import('./cli.ts');
process.exitCode = await main(process.argv.slice(2));
