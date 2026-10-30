# Flow Visualizer

Draw your flow on your real floor plan and see the queues in minutes.

An open-source, browser-based queuing and flow simulator. Upload a 2D floor plan, place simple blocks on it,
enter arrival and service data, and watch an animated simulation with KPIs checked against queuing theory.
Runs entirely in the browser; no install, account or API key.

> **Status: v0.1 feature-complete, in testing.** Simulation engine with theory checks, floor-plan editor,
> walking paths around walls, and an animated replay.

## Use it

Open it in a browser: **https://kepinpin-create.github.io/flow-visualizer/** (published from `main`).
Nothing to install, and it works on Windows, macOS, Linux, ChromeOS and tablets.

- **Offline:** after the first visit the app is cached and keeps working without internet. It can also be
  installed as an app from the browser's address bar.
- **Browsers:** current Chrome, Edge, Firefox and Safari. Older ones back to roughly Chrome 87, Firefox 78
  and Safari 14 run the editor and simulator; PDF import needs a recent browser (PNG/JPG work everywhere).
- **Touch:** drag blocks from the palette with a finger, pinch with two fingers to zoom and pan.
- **Private:** plans and models never leave your browser.

## AI helpers (optional, your own key)

The tool works fully without AI. With a key, two shortcuts appear in the toolbar:

- **AI layout** sends the uploaded plan to the AI, which proposes blocks and links. Everything it adds is marked
  **AI** on the plan. Numbers the plan does not show (arrival rates, service times) are left as placeholders and
  listed in **Checks**; the run stays blocked until you fill or confirm them. Undo removes the whole suggestion.
- **AI fill** turns a description such as "about 30 customers an hour, 3 tellers, 4 minutes each" into proposed
  changes. You tick which ones to apply.

The AI only ever returns JSON in the model format, which is schema-checked; it never writes or runs simulation code.

| Provider (⚙ AI settings) | Default model | Get a key |
| --- | --- | --- |
| Meta Model API (default) | `muse-spark-1.3` | [dev.meta.ai](https://dev.meta.ai/) |
| Anthropic Claude | `claude-opus-5-5` | [platform.claude.com](https://platform.claude.com/) |
| Other, OpenAI-compatible | your choice (must read images and return JSON) | OpenAI, Gemini, OpenRouter, or a local Ollama / llama.cpp server |

Keys stay in your browser (in memory, or on this device if you tick "Remember"). Requests go straight from the
browser to the provider; there is no server in between. The plan image and your notes are sent to the provider you
pick, so for confidential layouts use a local model.

## Using the editor

1. **Upload plan…** takes a PNG, JPG or PDF (first page). The Calibrate tool opens: click two points whose real
   distance you know and enter it in meters.
2. Drag blocks from the palette onto the plan (or click one to drop it in the middle).
3. Pick **Link**, then click the block the flow leaves and the block it goes to. Split the flow with a Decision.
4. Pick **Wall** and click points; double-click or Enter finishes.
5. Select anything to edit it on the right. Drag to move; corner handle resizes, top handle rotates.
   Delete removes, Ctrl+D duplicates, Ctrl+Z / Ctrl+Y undo and redo.
6. **Checks** lists what blocks the run; click an item to jump to its block. **Run simulation** when it is ready.
   Faint blue lines show the walking path of each link; they follow door gaps and update as you edit.
   A red dotted path means the walls leave no way through.
7. After a run, the plan replays the first replication: dots walk, queue and get served. Use play/pause,
   the speed menu (1× is real time) and the timeline to move through the day.
8. **Save model** downloads one JSON file with the plan image inside; **Open model…** loads it back.

## Run it locally

Needs Node.js 22.13 or newer (`.nvmrc` pins 24; with nvm, run `nvm use`). Works the same on Windows, macOS
and Linux: line endings are fixed by `.gitattributes`, and CI checks all three on every push.

```bash
npm ci             # exact versions from package-lock.json
npm run dev        # open http://localhost:5173
npm test           # engine benchmarks and validation tests
npm run build      # production build into dist/
npm run preview    # serve the build, including offline mode, at http://localhost:4173
```

On Windows PowerShell, if `npm` fails with "running scripts is disabled on this system", type `npm.cmd`
instead (for example `npm.cmd run dev`), or use Command Prompt.

### Deploying

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push to `main`.
One-time setup in the repo: **Settings → Pages → Source: GitHub Actions**.

## How it works

Every part of the app reads or writes one JSON **model spec** (`src/model/types.ts`). The engine knows seven
generic block types and nothing about bars, banks or factories; domain words are only labels.

| Block | Meaning | Key fields |
| --- | --- | --- |
| `source` | Entities arrive | `arrival` (rate per hour, or any distribution), `groupSize`, `maxArrivals` |
| `queue` | Entities wait for the Server it feeds | `capacity`, `discipline` (FIFO, LIFO), `balkThreshold` |
| `server` | Entities are processed | `servers` (c), `service` distribution |
| `resource` | Shared moving staff or equipment | `count` (placed only; not simulated yet) |
| `delay` | Time spent without a server | `time` distribution |
| `decision` | Splits the flow | `prob` on each outgoing link, summing to 1 |
| `sink` | Entities leave | — |

Distributions (all in minutes): `fixed`, `exponential`, `normal` (truncated at 0), `uniform`, `triangular`.

### Trusting the numbers

- **Replications**: every run repeats with independent seeded random streams (30 by default) and reports
  means with 95% confidence intervals. The same seed always gives the same result.
- **Warm-up**: statistics before the warm-up time are discarded.
- **Theory check**: any station that is M/M/c (Poisson arrivals, exponential service, unlimited FIFO line,
  nothing upstream breaking that) is compared to Erlang-C for Wq and Lq. This covers open Jackson networks.
- **Little's Law**: L = λW is checked for the whole system and every waiting line on each run.
- **Warnings**: utilization ≥ 0.95, unstable stations, and a warm-up shorter than 3× the mean time in system.

The test suite (`tests/`) holds the published benchmarks: M/M/1, M/M/3 and M/M/5 at ρ up to 0.9, plus a
Jackson network with a split, all within 5% of theory over long runs.

## Project layout

```
src/model/      model spec types, JSON Schema, validation (FR-15)
src/editor/     plan upload, SVG canvas, palette and properties panel, undo/redo store
src/routing/    walking paths around walls (grid + A*)
src/replay/     animated replay of the event log
src/ui/         results dashboard
src/engine/     discrete-event engine, distributions, replications, Web Worker
src/analysis/   Erlang-C, traffic equations, M/M/c eligibility
src/templates/  built-in models as JSON (bank, bar)
tests/          benchmarks and validation tests (Vitest)
```

New templates are plain JSON files in `src/templates/`; no code change is needed to describe a new model.

## License

[MIT](LICENSE)
