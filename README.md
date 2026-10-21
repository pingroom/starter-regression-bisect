# PingRoom regression bisect starter

Find a candidate regression boundary by asking a tester about prebuilt revisions.
Supply an ordered build catalog and known-good/known-bad endpoints. The starter
asks about the midpoint through PingRoom, records the attributed answer, and
narrows the range until adjacent builds remain.

**The result depends on your supplied boundaries and a monotonic regression:**
the symptom must remain present after it first appears. Flaky behavior, multiple
transitions, inaccurate endpoints, or changed artifacts invalidate that assumption.
The result is a candidate to investigate, not proof of a faulty commit.

## Try it offline

Requires Node.js 22 or newer on macOS or Linux, with persistent private local storage.
Choose **Use this template**, clone your repository, then:

```sh
npm ci
npm run demo
npm test
```

The demo uses the pinned SDK with a mock transport. A simulated tester marks
build 003 Bad and build 002 Good; the report identifies that boundary. It reads
no credentials, fetches no artifacts, and makes no live PingRoom calls. Package
installation requires npm access. Example build URLs are placeholders.

## Connect and configure

1. Install or open [PingRoom](https://pingroom.io/i), sign in, and choose a
   standard private room containing the tester.
2. Run `npm run connect`, open its claim link, and choose that room as the
   robot's home room. Grant the robot access to it. Reuse the same link while
   pairing is pending. Connecting sends no test question.
3. Run `npm run members` to list the room's human UUIDs. Copy
   `examples/catalog.json` to ignored `catalog.json`, then set `testerId` to the
   intended tester's UUID and replace every example build with your real catalog.

The catalog contains a case ID, short title, precise symptom, TTL, ordered
`builds`, and `knownGood`/`knownBad` revision IDs. The starter trusts the supplied
ordering; it does not inspect Git history. Include 2–64 distinct revisions and
use stable prebuilt artifacts. Endpoints are your assertions, not questions this
starter has asked. An already-adjacent pair completes with zero observations.

URLs must be canonical HTTPS URLs, at most 180 ASCII characters, without query
strings, fragments, or embedded credentials. Do not include signed download URLs
or secrets. The tester opens the link themselves and performs the described check.
The starter never downloads, builds, installs, checks out, or deploys a revision.

Connection stores ignored `.pingroom/credentials.json` with a `0600` file in a
`0700` directory. For CI or an existing credential, supply both `PINGROOM_TOKEN`
and `PINGROOM_ROOM`; exported values override project-root `.env`, then saved
credentials. Partial or blank pairs are rejected. CI requires the complete pair.
Room-read and question-ask access are needed, as well as the room grant.

## Run one bounded step

```sh
npm start
npm run status
```

The first step asks the selected tester **Good / Bad / Cannot test** about the
midpoint. The visible prompt identifies the exact revision, artifact URL, and
symptom. Direct questions are private to the asker and target, and only that
target's attributed answer can narrow the search.

Run `npm start` again to observe the question. A pending answer leaves the range
unchanged. Good moves the good boundary; Bad moves the bad boundary. A separate
invocation asks the next midpoint. Each invocation creates at most one question.
You may schedule this command periodically, but serialize invocations.

`Cannot test`, server-reported expiry, and cancellation produce `inconclusive`.
The starter never guesses a classification or treats a local timeout as server
expiry. Failed reads retain the known question ID for a later read. Questions
expire after the configured 30–86400-second TTL; stopping the runner does not
withdraw a question already sent.

```sh
npm run report
```

This local command writes private `.bisect/report.json` and prints the evidence:
supplied endpoints, observed classifications, question IDs, tester UUID, and
timestamps. `firstBadCandidate` is populated only after the range becomes
adjacent. Inspect that candidate independently before attributing a cause.

## Interrupted creation and recovery

Before each POST, the journal saves the fixed payload, target, TTL, correlation,
and idempotency key. A crash, timeout, malformed response, or lost response may
leave `creation_unknown`. Running again never resends that request. The persisted
idempotency key does not authorize the starter to retry automatically.

```sh
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

`find-id` performs a bounded read of recent questions and returns correlation
matches as candidates. Absence does not prove creation failed. The list can also
exceed the 64 KiB response limit; obtain the exact ID from the original response
or your PingRoom question record when available. Recovery reads that exact ID
and verifies room, target, payload, options, correlation, timestamps, and answer
attribution before attaching it. It creates no question. A known ID with an
unverified malformed response can also be corrected this way; a verified receipt
cannot be replaced.

If attribution or response validation fails, keep the journal and investigate.
Do not edit the evidence, delete state, or start another checkout to retry an
uncertain question. Changing the case, catalog, room, or credential is refused
once a search starts. Use another checkout only for an intentional new search
after resolving any outstanding question.

Journals flush files and directory entries and use atomic replacement. Keep the
private directory on persistent storage; this is not distributed coordination.
If a crash leaves `.bisect/.lock`, confirm the original process has stopped
before removing only that lock directory. All writers must honor the lock.

## Adapt and verify

Import `step` from `src/engine.mjs`, supply the validated catalog, explicit
connection, SDK client from `makeClient`, and private state directory. Application
code owns midpoint selection and evidence validation; no model evaluates answers.
The fixed HTTPS transport rejects redirects and bounds response bytes and total
response time, including stalled or empty body chunks.

CI uses credential-free tests and the demo on Node 22 and 24. Live phone delivery
and real tester behavior are not tested. Exit codes are `0` for ready, pending,
complete, and local commands; `2` for unknown creation or an inconclusive search;
`1` for validation, transport, or filesystem failures.

The official [SDK](https://github.com/pingroom/sdk) is pinned to 0.6.0 with a
lockfile. Unlike the [human review starter](https://github.com/pingroom/starter-human-review),
this workflow collects diagnostic observations and never executes an approved action.

MIT licensed; see [LICENSE](LICENSE).
