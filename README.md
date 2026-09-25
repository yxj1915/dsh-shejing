# dsh-shejing (摄鲸)

A photo workflow plugin for [DeepSeek Harness](https://github.com/deepseek-harness) that drives
**Adobe Lightroom Classic** through its own engine and catalog — checkup, cull, organize, grade,
verify, archive, retrospective.

The whole design has one goal: **make every mistake become a rule for next time, instead of
becoming rework.**

> 中文文档见 [README.zh-CN.md](README.zh-CN.md)。

## Why this exists

This workflow grew out of real failures, not a whiteboard. Two of them shaped everything:

- **25 photos were turned magenta** in one batch. A tone-curve parameter set was applied to a
  whole batch without first verifying it on a single frame. The curve's first point sat at
  `(0, y)` with `y ≠ 0`, which made Lightroom's spline diverge across the red/blue channels.
  Diagnosing and rolling it back took a dozen rounds.
- **A batch was graded before duplicates were culled**, so 28 burst frames were edited for nothing.

So the hardest rule in this plugin — *any new parameter combination must be rendered on a single
photo and seen by you before it touches a batch* — is not a prompt instruction. It is enforced by
a hook that DSH routes to you natively. You can approve it; the model cannot fake your approval.

## The seven stages

| Stage | Tool | Gate |
|---|---|---|
| Checkup | `shejing_checkup` | — (read-only) |
| Cull | `shejing_cull` | marking/moving gate |
| Organize | `shejing_organize` | irreversible gate |
| Grade | `shejing_grade` | **new-parameter gate** |
| Verify | `shejing_verify` | — (read-only) |
| Archive | `shejing_archive` | export confirmation |
| Retrospective | `shejing_retro` | write confirmation |

Plus `shejing_doctor` (self-check) and `shejing_batch_status` (read the ledger).

**Checkup** groups bursts, measures per-group sharpness and exposure spread, classifies each group
(burst / exposure bracket / suspected focus stack / panorama), reports highlight and shadow
clipping, and renders a contact sheet. It never touches Lightroom — it runs **before** import.

**Cull** builds `可导入/` ("importable") and `非导入/` ("not imported") inside the source folder and
*moves* files between them — same-volume rename, instantly reversible. Originals are never deleted.

**Grade** applies one of three built-in looks (A warm cinematic / B airy daylight / C deep dusk) or
explicit parameters, creating a snapshot per photo and rendering a preview so you can see it.

## Requirements

- **macOS** (Windows is not verified yet)
- **DSH desktop client** (the Electron app) or `dsh web`
- **Lightroom Classic** running, with the bundled plug-in loaded
- Node.js ≥ 18 (DSH ships one) — no separate Python install needed, DSH's bundled runtime
  includes Pillow and numpy

## Install

Through the DSH desktop client's plug-in manager, or:

```bash
dsh plugin --profile <profile> add dsh-shejing
```

The plugin registers itself as a profile layer and ships its own skill, so there is nothing to
symlink and nothing to copy into `~/.dsh/skills`.

**Restart DSH after installing.** Client-module metadata is cached until restart, so a page
refresh alone will not pick up the browser half.

First run: ask the model to call `shejing_doctor`. It reports whether the Lightroom plug-in is in
sync, whether the auth token exists, and whether the bridge port is listening.

## Safety model

- **Read-only until you say otherwise.** Checkup and verify never mutate anything.
- **Mark, never delete.** `非导入/` is kept forever; deleting originals is your call, never the
  tool's.
- **Never writes `.lrcat`.** The Lightroom catalog database is only ever read, and only from a
  copy. All mutation goes through Lightroom's own API.
- **Never writes `ProcessVersion`** (that downgrades photos).
- **No force flag on the parameter gate.** Verified parameter sets are whitelisted, so the same
  look never asks twice.

## Compatibility

The bundled Lightroom bridge is a fork of [`@pired/lightroom-mcp`](https://github.com/pired/lightroom-mcp)
(MIT, upstream [`Automaat/lightroom-mcp`](https://github.com/Automaat/lightroom-mcp)), with two
fixes: localized color-label names, and `create_collection` actually honouring its `parent`
parameter. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Development

```bash
node scripts/build-client.mjs   # build the browser half (no toolchain needed — it is a wrapper)
node scripts/test.mjs           # all six suites (needs DSH_HOME for two of them)
node scripts/regression.mjs <cloned-batch-dir>   # end-to-end on a real batch (~7 min for 75 frames)
```

The suites are:

| Suite | What it covers |
|---|---|
| `smoke.mjs` | tool registration surface, every gate path, skill parsing, panel routes |
| `smoke.mjs --no-connection` | graceful activation when a service is missing |
| `check-client.mjs` | actually renders every panel tab with a fake React (catches things `node --check` cannot) |
| `test-bridge.mjs` | the LR channel: MCP handshake, image blocks, `success:false`, reconnect, clear errors — against a fake bridge |
| `test-tools-lr.mjs` | the grading flow end to end against a fake bridge: what actually reaches the wire, the curve-endpoint guard, and the gate's ask → approve → whitelist cycle |
| `test_grouping.py` | the burst grouping algorithm must produce a *partition*, plus 200 randomized rounds |

`scripts/regression.mjs` drives the real tool implementations against a cloned batch, so it covers
parameter translation, path resolution and ledger writes — not just the Python scripts. It walks
eight steps: checkup → cull dry-run → cull → verify → archive plan → organize rename (dry/real) →
retrospective (dry/real) → graceful degradation when Lightroom is unavailable. Only "actually
export" and "actually write develop settings" need Lightroom; everything else verifies without it.

Both `test.mjs` and `regression.mjs` need `DSH_HOME` set so they never write into your real `~/.dsh`.
Pass `--reuse` to the regression to skip the slow checkup stage and re-test only the downstream steps.

Design decisions and the reasoning behind them are in [docs/DESIGN.md](docs/DESIGN.md).

## License

MIT. See [LICENSE](LICENSE).
