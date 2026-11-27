# Contributing

## How this repository works

This repository is a read-only copy of the source repository of alfaview. Each release of the
server updates the copy.

## Report a bug

Open an issue with the form [Bug report](https://github.com/alfaview/alfaview-for-mcp/issues/new?template=1-bug.yml).

Report a vulnerability as [`SECURITY.md`](SECURITY.md) describes, not in a public issue.

## Propose a change

Open an issue with the form [Feature request](https://github.com/alfaview/alfaview-for-mcp/issues/new?template=2-feature.yml)
before you write a large change.

A pull request is welcome. A maintainer does not merge it on GitHub. When a maintainer accepts the
change, the maintainer applies it in the source repository, and a later release brings it to this
repository. The commit names you as a co-author only when you agree.

## Build and test

Run these commands in the folder that holds `package.json`. The commands need Node.js 22.18 or
later: the tests run the TypeScript files with the type stripping of Node.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

The tests use mocks and a fake alfaview API on your computer. They send no request to the alfaview
API.
