# Security policy

## Report a vulnerability

Report a vulnerability in private, in one of these ways:

- The form [Report a vulnerability](https://github.com/alfaview/alfaview-for-mcp/security/advisories/new)
  on GitHub.
- An email to [security@alfaview.com](mailto:security@alfaview.com).

Do not report a vulnerability in public, such as in an issue, a pull request, a forum or a review.
Other people can read these at once.

## What a report holds

- The version of the server, the MCP client and the version of the MCP client.
- The part of the server with the problem: a tool or a setting of the server entry.
- The access level of the server entry (`ALFAVIEW_ACCESS_LEVEL`).
- The steps that show the problem, with the result that you get.
- The effect of the problem, such as data that an AI agent can read or change but must not reach.

Do not send a real API key, an access token or personal data. Where the steps need such a value,
write a placeholder.

## What happens next

A fix of a vulnerability comes in a new version of the server. [`CHANGELOG.md`](CHANGELOG.md)
names the changes of each version.

## Verify a release

The MCP client starts the server with `npx`, so the package is in none of your projects. To check
the newest version, install it in an empty folder and run `npm audit signatures` there:

```sh
mkdir alfaview-mcp-check
cd alfaview-mcp-check
npm init -y
npm install --ignore-scripts @alfaview-integrations/alfaview-for-mcp
npm audit signatures
```

The command checks the signature of each installed package. For this package, it also checks the
provenance: the source repository and the workflow that built the version.
