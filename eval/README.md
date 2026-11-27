# The model eval of the MCP server

In the default arm `server`, the eval gives a model customer tasks and the alfaview MCP server as
its only tools. It then checks what the model did. It runs each task with Claude Code in headless mode (`claude -p`)
against a fake alfaview API on 127.0.0.1. Run it before and after a change of the server, and
compare the two summaries. Two more arms measure the skill of the Claude Code plugin (see
[The arms with and without the skill](#the-arms-with-and-without-the-skill)).

## What it measures

The eval has 39 tasks at the four access levels: 26 base tasks and 13 hard tasks. Each task is a
request in the words of a customer. A prompt never names a tool, a parameter or an API field.
`npm run eval -- --list` prints the tasks, and `tasks.ts` holds them with their checks.

- Reads at the level read:
  - A room by a part of its name, and its passcode
  - The attendance of a webinar (the addresses of the no-shows) and of an appointment
  - The statistics of one day
  - The waiting room, with the option Personal data set to omit
  - 120 guest links, which need several pages
- Writes at the level standard:
  - Guest links for several guests at once, with no email, and their join URLs in the answer
  - A guest link in the time zone of the guest
  - A guest link with an email that the person asks for
  - The create, the move and the cancel of a meeting
  - The delete of the links of ended Calendly bookings, but not of the bookings that run now or
    later
- Writes at the level manage: transcription and translation, a room feature, file sharing, a
  feature and file sharing in one request, a room property and transcription in one request, and
  breakout rooms.
- Writes at the level full: a room permission, the delete of a named room, and the delete of a
  named user. Each delete passes only with exactly one question of the server to the person that
  names the room or the user, and that the person accepts (see "Questions to the person").
- Negative tasks, in which the agent must change nothing:
  - A change that the level does not allow
  - A meeting change that would email a guest, but the person forbids emails
  - A room delete without a clear target
  - A user delete without a clear target

The hard tasks have IDs that start with `hard-`. Each needs several steps, has a trap in its data,
or must recover from an error of alfaview. So they can show a difference between two servers, and
not only a difference of cost:

- `hard-paging-second-date` (read): count the guests of the second date of a webinar, 43 of 120
  links with one origin on three pages. The answer must not give 43 for the first date or 77 for
  the second.
- `hard-attended-not-registered` (read): compare the attendance of a past webinar with the
  registrations of the next one. One address is in capital letters, and one guest was in the
  room for 2 minutes only. The check reads the lines that hold only an address, so a note after
  the list can name another address.
- `hard-omit-email` (read, Personal data set to omit): the person asks for an email address that
  the server leaves out. The answer must not invent an address of Jane, and it must say that the
  server leaves out personal data. "I can't find her" is not enough.
- `hard-meeting-guest-setup` (standard): a meeting in New York time, then a guest link for that
  meeting for four people, with the links in the answer. A change of the time after the links
  fails, because alfaview then emails the guests.
- `hard-guests-thirty` (standard): 30 rows, more than one call takes, with one person twice in
  another case. Each person gets exactly one link. The model sees both rows of Lea Wagner in the
  prompt, so this trap measures how the model reads the list. `hard-retry-guest-links` tests the
  repeat check of the server.
- `hard-dst-guest-link` (standard): a guest link in New York time on a day on which New York is
  five hours behind Berlin, not six, and the start in Berlin time. The check reads only the times
  that the answer gives in Berlin time, not those in UTC or in New York time.
- `hard-retry-guest-links` (standard): alfaview saves the second of three links but answers 500.
  Nobody gets a second link.
- `hard-retry-meeting` (standard): alfaview saves the meeting but answers 500. The agent finds
  the meeting and does not create a second one, and it writes nothing else.
- `hard-quiet-guest-removal` (standard, negative): remove the guest of a meeting without a
  message, which alfaview cannot do: it always emails the guest when her link is deleted. The
  agent must look at her link, and the answer must connect the email with the delete.
- `hard-vague-room` (manage, negative): a room name that fits two rooms. The agent must look at
  the rooms before it asks.
- `hard-unsupported-language` (manage, negative): transcription in a language that alfaview
  does not offer. The answer names the languages that alfaview offers, after a look at its list.
  A write that alfaview refuses passes, because it changes nothing.
- `hard-breakout-groups` (manage): five named breakout rooms and the delete of the unnamed one,
  when alfaview answers one create with 429. The task expects one create for each breakout room.
  A server with one write for all breakout rooms (a `PATCH` of the room with its list of
  breakout rooms) needs a change of the task: allow that `PATCH` and move the fault to it.
- `hard-delete-declined` (full, negative): the person asks for a room delete, but says no when
  the server asks. The task passes only when the server asked the person through the client
  (see "Questions to the person"), the question names the Webinar Room, the person said no, and
  nothing is deleted. A server that deletes without a question to the person fails. A run with
  no question from the server fails too, also when the model asks "Are you sure?" in its answer.
  So the fallback of a client that cannot ask, in which the model fills in `confirmRoomName`,
  fails this task by design.

Some hard tasks mostly guard the server against a regression and say little about its quality:
`hard-paging-second-date` and `hard-vague-room`. Read the cost data of `hard-paging-second-date`
and `hard-breakout-groups` (input tokens, calls), not only their pass rate.

A task can name faults: requests that the fake API answers once with an error status, such as 429
or 500 (`FakeFault` of `test/fake-api/server.ts`). A fault can apply the request before its
answer, as when alfaview saves a create and then times out. Such a fault counts only
the requests that the fake applies with success: a request that the fake refuses, such as with
422, gets its own answer. A fault without `applied` counts every matching request, valid or not.
A fault that never fires is a run problem, and the run fails: the run did not test the recovery
from the error, such as when a server sends all guests in one request.

A check reads the state of the fake API after the run and the requests that reached it. Some
checks also look for a fact in the final text, such as a passcode, a count or a join URL, and
some read the questions of the server to the person. A check never names a tool, so the checks
stay true when tools merge or get new names. A write task also checks that every write goes to
what the person named, and that nothing is deleted that the person did not ask to delete. A run
passes when every check passes.

For each run, the eval records these data:

- Each check with its result
- Each tool call, with the size of its result and whether the result was an error
- The model requests, the turns of Claude Code, the input tokens (with the cache), the output
  tokens, the cost and the time
- Each question of the server to the person (MCP elicitation) and its answer
- The requests with which alfaview would email someone
- The requests that do not fit `spec/openapi-v2.json`. Such a request is a problem of the server,
  not of the model.
- The feature flags of Claude Code that its debug log names, with their source

## It never reaches alfaview

- Each run starts a new fake API (`test/fake-api/server.ts`) on 127.0.0.1 with a free port.
- Claude Code starts the built server with the preload `test/fake-api/route-fetch.ts`. The preload
  sends the requests for `https://apis.alfaview.com` to the fake API. It refuses every other URL.
- The server gets the fake credentials of the tests (`TEST_ENV` of `test/helpers/spawnServer.ts`).
- The eval reads no `.env` file and sets no API key. Claude Code uses the login of the person. The
  eval gives claude only `HOME`, `PATH`, `USER`, `LOGNAME`, `TMPDIR`, `LANG` and
  `CLAUDE_CONFIG_DIR` of its environment, and `CLAUDE_CODE_OAUTH_TOKEN` when the profile logs in
  with a long-lived token of `claude setup-token`. That token is the subscription login of the
  person. `ANTHROPIC_API_KEY` never passes, and a run with an API key source other than "none" is
  invalid.
- Claude Code itself still talks to Anthropic: the model API, the refresh of the login, and the
  managed settings and policy limits of the account. The eval sets
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, which turns off the telemetry, the event log and the
  network fetch of feature flags.

## Run it

1. Build the server. The eval stops when `dist/main.js` is missing or older than a file of `src/`.

   ```sh
   npm run build
   ```

2. Run the tasks. The default is all tasks, once, with `claude-sonnet-5-5` and `claude-haiku-5-5`.

   ```sh
   npm run eval -- --label baseline
   npm run eval -- --models claude-haiku-5-5 --tasks read,neg-delete-vague --repeat 3
   ```

3. Compare two summaries.

   ```sh
   npm run eval -- --compare eval/results/baseline-<time>/summary.json eval/results/after-<time>/summary.json
   ```

`npm run eval -- <options>` runs `node eval/main.ts <options>`.

When a baseline has only the 26 base tasks, also run the hard tasks with both models on the
server before the change. Compare the run after the change with that summary too:

```sh
node eval/main.ts --label baseline-hard --repeat 3 --tasks hard-paging-second-date,hard-attended-not-registered,hard-omit-email,hard-meeting-guest-setup,hard-guests-thirty,hard-dst-guest-link,hard-retry-guest-links,hard-retry-meeting,hard-quiet-guest-removal,hard-vague-room,hard-unsupported-language,hard-breakout-groups,hard-delete-declined
```

`npm run eval -- --help` lists every option. These options change what a run measures:

- `--effort`: the effort of Claude Code, `medium` by default. Use the same value before and after.
- `--max-turns` (15) and `--max-budget-usd` (0.5): the limits of each run. A run that reaches a
  limit counts, and it fails the checks that it did not meet. The table of each model and
  `--compare` count these runs and list them with their result (`error_max_turns` or
  `error_max_budget_usd`).
- `--timeout` (300 seconds): a run that takes longer counts, and it fails.
- `--config-dir`: the folder of the Claude Code login. The default is `CLAUDE_CONFIG_DIR` of the
  shell.
- `--arm`: `server` (the default), `plain` or `skill`. See
  [The arms with and without the skill](#the-arms-with-and-without-the-skill).

Each run gives the server the access level and the option Personal data of its task, and the time
zone `Europe/Berlin`. Only the tasks of the level full get the opt-in of that level.

Claude Code gets no settings files of the person or the project, no `CLAUDE.md`, no memory, no MCP
servers of claude.ai and no advisor model. Its only settings are those of the run, with the
Elicitation hook (see "Questions to the person"). In the default arm `server`, it also gets no
built-in tools and no skills, and all tools of the server load at the start, without ToolSearch.

Ctrl+C, `SIGTERM` and `SIGHUP` stop each claude run and remove its temporary folder. The finished
runs stay in the results folder, but no summary is written.

## The arms with and without the skill

The option `--arm` sets what Claude Code loads next to the server:

| Arm | Built-in tools | Skills | Use |
| --- | --- | --- | --- |
| `server` (the default) | None | None | Measure a change of the server |
| `plain` | `Skill`, `Read` and `ToolSearch` | None | The baseline for the skill |
| `skill` | `Skill`, `Read` and `ToolSearch` | `alfaview-mcp:alfaview-meetings` | Measure the skill of the plugin |

The arm `skill` loads the plugin of this package with `--plugin-dir plugins/alfaview-mcp`. Claude
Code reads the plugin in that folder, so a run measures the skill files of the checkout.

The arms `plain` and `skill` use the same arguments and the same settings, and only
`--plugin-dir` is different. So their comparison measures the skill alone, and not the change of
the tools. The arm `server` is not their baseline, for these reasons:

- `--disable-slash-commands` of the arm `server` turns off all skills, also the skill of the
  plugin. So the two arms do not use it. Their settings remove the skills of Claude Code itself
  instead: `disableBundledSkills`, the entry `"doctor": "off"` of `skillOverrides`, and
  `cc-plugin-plugin-authoring@builtin` set to `false` in `enabledPlugins`. That built-in plugin
  holds a skill.
- With `ToolSearch`, Claude Code defers the schemas of the tools of the server. In both arms, the
  model loads them with `ToolSearch` before its first call of the server.
- `Read` is allowed only for the files of `plugins/alfaview-mcp/`, with the rule
  `Read(//<absolute path of the folder>/**)`.

`--strict-mcp-config` stays in all arms. So Claude Code does not start the server of the plugin
manifest, which runs the published package against alfaview. Each run uses the built server and
the fake API.

A run of `plain` or `skill` is invalid, and does not count, in these conditions:

- In `plain`, the init event of Claude Code lists a skill, or the model calls `Skill`.
- In `skill`, the init event lists a skill other than `alfaview-mcp:alfaview-meetings`, or it does
  not list that skill. The model calls `Skill` for another skill or command, such as `init`.
- The model gets a built-in tool other than `Skill`, `Read` and `ToolSearch`, or Claude Code starts
  an MCP server other than `alfaview`.

The text of the skill after a call of `Skill` is not a message from outside the run. Claude Code
writes it as a synthetic user event that starts with the folder of the skill. Each other text of
a user event still makes the run invalid.

In the table of each model, "calls" counts the calls of the tools of the server. "client calls"
counts the calls of `Skill`, `Read` and `ToolSearch`. "errors" counts only the error results of
the server. `--compare` prints the arm of each summary. The acceptance bar (`--bar`) scores a
change of the server. Its item 1 misses when a summary has an arm other than `server`.

The calls of `Skill`, `Read` and `ToolSearch` count against `--max-turns` and `--max-budget-usd`,
as the calls of the server do. So a run of `skill` can reach a limit before the same task in
`plain` does. Such a run counts, and the limit alone can make it fail. The table of each
model and `--compare` show the runs that ended on a limit. Read the stream of each such run before
you compare the pass rates of the two arms. A higher limit must have the same value in both arms,
because the comparison warns when `maxTurns` or `maxBudgetUsd` differs.

Run the two arms on the same day, with the same models and repeats, then compare them:

```sh
npm run build
node eval/main.ts --arm plain --label plain --repeat 3
node eval/main.ts --arm skill --label skill --repeat 3
node eval/main.ts --compare eval/results/plain-<time>/summary.json eval/results/skill-<time>/summary.json
```

On 2026-11-26, Claude Code 2.1.332 listed 17 skills in the init event of a run of `plain` without
these settings. One of them was `plugin-authoring` of the built-in plugin. With the settings, the
init event of `plain` lists no skill, and that of `skill` lists only
`alfaview-mcp:alfaview-meetings`. Look at the skills of the
init event again after a new version of Claude Code. A new bundled skill or built-in plugin makes
each run of the two arms invalid until the settings remove it.

## Questions to the person

Claude Code tells each MCP server that it can ask the person (MCP elicitation), also in
`claude -p`. In `claude -p`, nobody can answer, and without a hook Claude Code answers cancel. So
each run gives Claude Code an Elicitation hook (`elicitation-hook.ts`) that answers as the person
of the task:

- The person accepts a question only when it names what the person asked for, by its name, email
  address or ID (`elicitation` of the task). The person then answers yes to each yes or no field,
  and types the name of the target into each text field.
- The person declines every other question. A task without rules declines all questions.

So the eval measures the path of a client that can ask the person, as Claude Code is. It cannot
measure the fallback of a tool for a client that cannot ask (such as `confirmRoomName`), because
Claude Code always tells the server that it can ask. The tests of the server cover that fallback.

`--probe-elicitation` checks this path before a run relies on it. It runs claude twice with a stub
server (`elicitation-probe-server.ts`) whose one tool asks the person with `elicitation/create`:
once with a person who accepts, and once with one who declines. The probe passes when the
question reaches the hook and the answer of the hook comes back to the server.

```sh
node eval/main.ts --models claude-haiku-5-5 --probe-elicitation
```

On 2026-10-28, with Claude Code 2.1.312 and the protocol version 2025-11-25, the probe passed for
both answers. The stub server sends the question as a request of the server, as the protocol
version 2025-11-25 does. The protocol version 2026-07-28 asks through a result with
`input_required` instead. A server that moves to it must still ask a client of the version
2025-11-25 with `elicitation/create`, or `hard-delete-declined` fails with this client. Run the
probe again after a new version of Claude Code, and look at the protocol version of the runs.

The server of SDK v2 serves both versions. Against it, Claude Code 2.1.312 negotiates 2026-07-28.
So its questions reach Claude Code as `input_required`, which the stub server of the probe does not
send. Check that path with a run of a delete task before a run relies on it:

```sh
node eval/main.ts --label confirm-probe --models claude-haiku-5-5 --repeat 1 --tasks delete-room-clear
```

Read `elicitations` of the run in `summary.json`: one question with `action` `accept`.
`delete-room-clear` and `delete-user-clear` pass only with one accepted question, so a valid run
of the two tasks is that check.

## Results

The eval writes into `eval/results/<label>-<time>/`, which git ignores:

- `summary.json`: the options, the environment (the versions of Claude Code and of the server,
  its feature flags, the git commit), a summary per model, and the record of each run. The summary
  of a model holds the input tokens for each model request at each level (`levels`), and the
  summary of each task holds the questions to the person (`questions`).
- `<model>/<task>-run<n>.json`: the record of one run.
- `<model>/<task>-run<n>.stream.jsonl`: the raw stream of Claude Code. It shows each tool result
  as the model saw it.

The eval prints a table per model. A row gives the pass rate of a task and the means of its runs:
the calls of the tools of the server, the calls of the tools of Claude Code (only in the arms
`plain` and `skill`), the error results of the server, model requests, turns of Claude Code (all
tool calls plus one), tokens, cost and time. Then it prints the input tokens for each model
request at each level, and the questions to the person of each task that asked. The runs that
ended on a limit, the failed checks and the run problems follow.

The input tokens for each model request come by two methods, over the valid runs with a model
request:

- "mean of runs" divides the input tokens of each run (with the cache) by its model requests, and
  takes the mean of the runs of the level. Item 5 of [the acceptance bar](#the-acceptance-bar)
  uses this method.
- "pooled" divides all the input tokens of the level by all its model requests.

The two methods differ most at the level read, where the runs have few model requests. The
questions to the person show the questions of each valid run and the answers: accept, decline or
cancel. The hook of the eval gives only accept or decline.

A run fails, and counts, when it has a problem that the server can cause: a timeout, a server
that did not connect, or a run that ended without its result or with an error. A run is invalid,
and does not count, only when a cause outside the server spoiled it: a rate limit, an error of the
model API (also a Claude Code that is not logged in, which writes the error as a message of the
model), a second model, a run that was not isolated (another tool, another MCP server, an API key,
a message from outside the run, or a skill that its arm does not allow), or a run that the eval
could not start. The table lists each invalid run with its reason.

`--compare` prints the arm of each summary. For each model, it prints the valid runs, the invalid
runs and the runs that ended on a limit. A summary without an arm counts as the arm `server`. It
computes the success rate and the means only over the tasks with valid runs in both
summaries, and it lists the other tasks. Over the same tasks, it prints the input tokens for each
model request at each level by both methods, with the change, and the questions to the person of
each task that asked in one of the summaries.
It warns when the tasks, the repeats, a limit, the effort, the version of Claude Code, its feature
flags or the MCP protocol versions differ. It also warns when the two summaries started on other
days in Berlin time, and when the prompt of a task differs in more than its dates and times.

The prompts name dates relative to the day of the run. Thus runs of two days compare other
prompts. `hard-dst-guest-link` and `hard-meeting-guest-setup` can then also get another gap
between New York and Berlin: from 2026-10-31, the next day with a gap of five hours is in March
2027. Compare runs of one day, or at least of one period of daylight saving time in Europe and the
USA.

## The acceptance bar

`--compare <baseline> <after> --bar` also scores the acceptance bar of a change of the server for
each model. It reads the summary files only, and it starts no run. The baseline is a run of the
server before the change, on the same day as the run after it. Each item holds over the tasks with
valid runs in both summaries:

1. **Valid runs**: no run is invalid for a cause of the server, the contract problems stay at 0,
   Claude Code, its feature flags and the options are those of the baseline, and each summary has
   the arm `server`.
2. **Success**: the passed runs are at least the passed runs of the baseline minus 1, for each
   model. A task that passed 3 of 3 in the baseline and passes 2 of 3 or fewer after runs 5 more
   times, and its 8 runs need 7 passes. No task passes fewer runs than in its baseline after those
   repeats. `guest-links-cleanup-calendly` with Haiku needs at least 2 of 3.
3. **Tool calls**: the mean for each model over the 39 tasks is not higher than in the baseline.
4. **Error results**: the mean for each model over the 39 tasks is not higher than in the
   baseline. A refusal that a task expects counts in both runs the same.
5. **Input tokens for each model request**, over the 26 base tasks, for each level and model, are
   lower than in the baseline by at least: `read` 8 percent, `standard` 14 percent, `manage` 17
   percent, `full` 18 percent.
6. **Questions to the person**: `delete-room-clear` and `delete-user-clear` show one accepted
   question in each run, `hard-delete-declined` one declined question and no delete, and no other
   task asks.
7. **Friction of Haiku** (targets): `delete-user-clear` at most 4.5 calls and at most 0.34 error
   results, `settings-file-sharing` at most 2.67 calls and no error result, `delete-room-clear` at
   most 3 calls. A miss of a target blocks only when the task is worse than in its baseline.

Each item gets one of these results, with its figures:

- pass: the item holds.
- miss: the item does not hold, and the line of the figure says MISS.
- open: the summaries cannot decide the item, and the line says why. For example: an invalid run
  (item 1), a task that needs its 5 more runs (item 2), a summary without all 39 tasks (items 3
  and 4) or without all 26 base tasks (item 5), or a target of Haiku that a task misses although
  it is not worse than in its baseline (item 7), because a person must find the cause of the miss
  in the streams.

Item 5 uses the mean of runs of [Results](#results). Item 7 takes a task as worse than in its
baseline when a figure of its target is higher. Item 2 names each task that passed 3 of 3 in the
baseline and fails a run after, and prints the command for its 5 more runs. Give the summary of
those runs with `--more-runs <file>`. The bar then adds them to the 3 runs of the task, and its 8
runs need 7 passes.

```sh
node eval/main.ts --compare eval/results/baseline-<time>/summary.json eval/results/final-<time>/summary.json --bar
node eval/main.ts --compare <baseline> <after> --bar --more-runs eval/results/more-runs-<time>/summary.json
```

`bar.ts` follows the items above. A change of an item needs the same change in `bar.ts` and in its
tests.

## Cost

The cost figures are the estimates of Claude Code from the first runs on 2026-10-28. The runs use
the subscription of the login, and they count against its limits.

- `claude-haiku-5-5`: $0.001 to $0.008 for each run, about $0.06 for the 26 base tasks, and
  about $0.03 for the 13 hard tasks.
- `claude-sonnet-5-5`: about $0.04 for a short read. The 26 base tasks cost about $1 to $2.

A run takes 3 to 10 seconds. Three runs go at the same time by default.

## Known limits

- The checks of the final text use regular expressions. They look for a fact, such as a number, a
  name or an address, and not for the full meaning of the answer. A refusal for a wrong reason
  (such as "I can't find that room") passes the answer check of `neg-level-room-change`, but its
  checks of the state still hold.
- Some checks of the hard tasks join a value with the nearest label in its sentence: a clock time
  with its time zone, or a count with its date. An answer with an unusual form can fail them, or
  pass them, by mistake. Read the final text of a run that fails such a check.
- The state of the fake API moves to the start of each run. A prompt that needs a date or the time
  gives it in full, in Berlin time, so the model does not have to know the date.
- Claude Code 2.1.312 gives the model only the structured content of a tool result, not its
  summary text. An error result gives the model the error message.
- The user IDs of the fixtures do not have the form of alfaview user IDs, and the server refuses
  them. Thus each task that can change a user gives that user a correct ID.

## Add a task

1. Add the task to `TASKS` in `tasks.ts`: an ID, the level, the kind, the prompt, and the checks.
   Write the prompt as a customer writes it. Do not name a tool, a parameter or an API field.
2. Write checks of the state and the requests. Give each check a short reason. Add a check of the
   final text only for a fact that the person asked for. A write task also gets a check of the
   paths of its writes (`writesOnlyUnder`) and, when it deletes nothing, `noDeletes`.
3. When the server can ask the person, give the task its `elicitation` rules. When the task tests
   the recovery from an error of alfaview, give it its `faults`. A negative task that passes when
   the agent does nothing also needs a check that the agent looked: a read of what the person
   named, or a question of the server.
4. Run `npm test`. The tests in `test/eval/` check the form of each task. They also check that a
   write fails on the untouched state, and that a negative task passes there.
5. Run the new task once with each model, and read the stream of each run that failed.
