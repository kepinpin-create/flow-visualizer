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

### Quick start (5 minutes)

1. Open the link above and click **Try the bank example**. The editor opens with a small bank already run:
   watch the replay, then scroll down to the results.
2. Click **Upload plan** and pick a PNG, JPG or PDF of your floor plan
   ([`samples/bank-branch-plan.pdf`](samples/bank-branch-plan.pdf) works too).
3. Set the scale: click two points on the plan whose real distance you know and type it in meters.
4. Place the flow: either click **AI layout** (needs your own AI key, see below) or drag blocks from the left
   palette and connect them with **Link**: Source → Queue → Server → Sink.
5. Fill in the numbers **Checks** asks for (arrivals per hour, service minutes), then click **Run simulation**.
6. Improve it: **AI review**, **Layout scorecard** or **Optimize layout** under the results; **3D** above the
   plan; **AI picture** and **Technical drawing** for slides.

The link `…/app.html?example=bank&run=1` opens the bank example straight in the editor.

- **Offline:** after the first visit the app is cached and keeps working without internet. It can also be
  installed as an app from the browser's address bar.
- **Browsers:** current Chrome, Edge, Firefox and Safari. Older ones back to roughly Chrome 87, Firefox 78
  and Safari 14 run the editor and simulator; PDF import needs a recent browser (PNG/JPG work everywhere).
- **Touch:** drag blocks from the palette with a finger, pinch with two fingers to zoom and pan.
- **Private:** plans and models never leave your browser.

## AI helpers (optional, your own key)

The tool works fully without AI. With a key:

- **AI layout** sends the uploaded plan to the AI, which proposes blocks, links, walls and doorways. Blocks it adds
  show **AI-detected** in the properties panel. Numbers the plan does not show (arrival rates, service times) are
  left as placeholders and listed in **Checks**; the run stays blocked until you fill or confirm them. Undo removes
  the whole suggestion.
- **AI fill** turns a description such as "about 30 customers an hour, 3 tellers, 4 minutes each" into proposed
  changes. You tick which ones to apply.
- **AI review** (after a run) explains the bottleneck and suggests fixes, in English or Bahasa Indonesia. Each
  suggestion is simulated with the same seed before you see it, so its before/after numbers are measured.
- **AI layout advice** (in the layout scorecard) proposes moves and resizes, also re-simulated before you apply them.
- **Explain with AI** describes in plain words why the optimized layout is better.
- **AI picture** uses Meta's Muse Image (`muse-image-1.0`, about $0.01 per picture) to turn the layout, or the
  optimized layout with its people, into an illustration for slides. It may change details; numbers always come
  from the simulator.

The AI only ever returns JSON in the model format, which is schema-checked; it never writes or runs simulation code,
and it never decides a number shown in the results.

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
4. Pick **Wall** and click points; double-click or Enter finishes. **Door** cuts a doorway where you click a wall.
5. Select anything to edit it on the right. Drag to move; corner handle resizes, top handle rotates.
   Delete removes, Ctrl+D duplicates, Ctrl+Z / Ctrl+Y undo and redo.
6. **Checks** lists what blocks the run; click an item to jump to its block. **Run simulation** when it is ready.
   Blue lines show the walking path of each link; they follow door gaps and update as you edit, and **Paths**
   above the plan hides them. A red dotted path means the walls leave no way through.
7. After a run, the plan replays the first replication: dots walk, queue and get served. Use play/pause,
   the speed menu (1× is real time) and the timeline to move through the day. **Reset simulation** clears the
   replay and results; a new plan, template or opened model clears them automatically.
8. Below the results:
   - **Layout scorecard** grades flow order, crossing paths, queue space at the peak, doors kept clear and walking,
     and marks problem spots on the plan.
   - **Optimize layout** moves busy areas closer together (within their room, at most 6 m; blocks marked
     "Fixed in place" stay put) and simulates the result. Switch **Current layout / Optimized layout** above the
     plan to watch both replays at the same time of day, then apply it or make a picture of it.
9. **3D** (top right of the plan) shows walls, blocks and people walking in 3D, in sync with the replay;
   drag to orbit, scroll to zoom, click 3D again to go back. View only; editing stays in 2D.
10. **AI picture** turns the layout on screen into an illustration (Muse Image, your Meta key). In the same
    dialog, **Technical drawing** makes an exact plan with labels, sizes, dimensions and a scale bar, free and
    without a key, as PNG or SVG. Both follow the Current / Optimized view.
11. **Save model** downloads one JSON file with the plan image inside; **Open model…** loads it back.

## Run it locally

Needs [Git](https://git-scm.com/downloads) and [Node.js](https://nodejs.org/) 22.13 or newer (the LTS
download is fine; `.nvmrc` pins 24, so with nvm run `nvm use`). Works the same on Windows, macOS and Linux:
line endings are fixed by `.gitattributes`, and CI checks all three on every push.

From zero, in a terminal:

```bash
git clone https://github.com/kepinpin-create/flow-visualizer.git
cd flow-visualizer
npm ci
npm run dev
```

Then open **http://localhost:5173** (landing page) or **http://localhost:5173/app.html** (editor). Edits to the
code show up in the browser right away. Keep the terminal open; Ctrl+C stops the server.

All commands:

```bash
npm ci             # exact versions from package-lock.json
npm run dev        # landing page at http://localhost:5173, the editor at /app.html
npm test           # engine benchmarks and validation tests
npm run build      # production build into dist/
npm run preview    # serve the build, including offline mode, at http://localhost:4173
```

On Windows PowerShell, if `npm` fails with "running scripts is disabled on this system", type `npm.cmd`
instead (for example `npm.cmd run dev`), or use Command Prompt.

### Deploying

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push to `main`.
One-time setup in the repo: **Settings → Pages → Source: GitHub Actions** (not "Deploy from a branch", which
serves the unbuilt source and shows an unstyled page). Re-running an old deploy republishes that old version,
so to redeploy, re-run only the newest run or push to `main`.

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
  Stations behind an overloaded one are skipped with a note, since fewer people reach them than the formula assumes.
- **Little's Law**: L = λW is checked for the whole system and every waiting line on each run. While a station is
  overloaded, the whole system and that station's line show **Not steady** instead of a pass or fail.
- **Warnings**: unstable stations (load ≥ 100%), utilization ≥ 0.95, and a warm-up too short for the busiest
  station to fill up from empty (about 1 / (cμ(1 − √ρ)²); 380 min at 90% busy), with the warm-up it needs.
- **Normal times** are redrawn below zero, so their real average is above the typed mean; load and theory use the
  real one.

The test suite (`tests/`) holds the published benchmarks: M/M/1, M/M/3 and M/M/5 at ρ up to 0.9, plus a
Jackson network with a split, all within 5% of theory over long runs. The engine also matches fixed (M/D/1),
uniform (M/G/1) and full-line (M/M/1/K) results within 1%.

Known limits: one arrival rate all day (no rush hour), no one gives up after waiting, staff are identical and always
present, splits are fixed probabilities, and Resource blocks are not simulated yet.

## Project layout

```
index.html      landing page (src/landing.ts, src/landing.css)
app.html        the editor (src/main.ts); app.html?example=bank&run=1 opens a template and runs it
src/model/      model spec types, JSON Schema, validation (FR-15)
src/editor/     plan upload, SVG canvas, palette and properties panel, undo/redo store
src/routing/    walking paths around walls (grid + A*)
src/replay/     animated replay of the event log
src/ai/         AI providers (bring your own key), AI layout, walls, fill, review, pictures
src/layout/     layout optimizer, rooms, scorecard, AI layout advice
src/ui/         results dashboard, step bar
src/engine/     discrete-event engine, distributions, replications, Web Worker
src/analysis/   Erlang-C, traffic equations, M/M/c eligibility
src/templates/  built-in models as JSON (bank, bar)
tests/          benchmarks and validation tests (Vitest)
```

New templates are plain JSON files in `src/templates/`; no code change is needed to describe a new model.

## License

[MIT](LICENSE)
