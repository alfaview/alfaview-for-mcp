// Stands in for test/helpers/spec.ts in the eval process (main.ts). The real module registers hooks
// of node:test when it loads, which would print a test report and set the exit code of the eval.
// The eval checks the requests of each run against the spec itself (runner.ts).

/** Does nothing: the eval checks the recorded requests after each run. */
export function keepContractProblems(): void {}
