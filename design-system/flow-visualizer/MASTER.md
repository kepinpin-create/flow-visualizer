# Flow Visualizer design system (MASTER)

Source of truth for the app's look and interaction. Page-specific overrides would go in `pages/<page>.md`.
Rules follow the ui-ux-pro-max checklist (WCAG 2.2 AA, platform conventions). Values below are this
project's choices, not figures from an external dataset.

## 1. Product and audience
- **Type:** productivity tool / editor with a results dashboard (single page).
- **Audience:** industrial-engineering students and lecturers, service managers, hackathon judges.
  Mostly laptop and desktop; must still work on tablets and phones (375 px).
- **Style keywords:** clean professional tool, content-first, calm, light and dark.

## 2. Pattern
```
Header      brand | File (template, upload, open, save) | AI (layout, fill, picture, settings) | Run (primary)
Step bar    1 Floor plan · 2 Blocks & flow · 3 Numbers · 4 Run · 5 Improve   (status + one click to act)
Workspace   Blocks palette | Stage (canvas toolbar + plan) | Properties
Bottom      Checks | Results (AI review, optimize, KPIs, theory) | Model JSON (disclosure)
```
Canvas tools (select, link, wall, calibrate, undo, redo, fit) live on the stage, next to what they act on.

## 3. Style: "Clean Pro Tool"
- Flat surfaces separated by 1 px borders; one soft elevation for floating UI (dialogs, overlays).
- Radius: 6 px controls, 10 px panels, 12 px dialogs, 999 px pills.
- One accent (blue) for the single primary action per view; AI actions use an "AI" subtle-accent style.
- Icons: one inline SVG family (Lucide-style, 24 viewBox, 2 px stroke, round caps), 16 px in buttons.
  Never emoji or text glyphs as icons. Icon-only buttons always have an accessible name.

## 4. Color tokens (semantic; light / dark designed together)
| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #f5f6f8 | #101319 | page |
| `--panel` | #ffffff | #181c24 | surfaces |
| `--panel-2` | #f0f2f6 | #1f2430 | inset surfaces, hover |
| `--text` | #1a2130 | #e7eaf0 | body text (≥ 12:1) |
| `--muted` | #566074 | #a0a9b8 | secondary text (≥ 4.5:1 on panel) |
| `--border` | #dde1e8 | #2c3340 | dividers |
| `--accent` / `--accent-text` | #2357d9 / #fff | #7ea2ff / #0b1020 | primary action (≥ 4.5:1) |
| `--accent-soft` | #e7eefe | #1f2a46 | selected / AI subtle |
| `--ok`, `--bad`, `--warn` (+ `-bg`) | see style.css | see style.css | status, always with text |
Contrast pairs checked: body, muted, accent button, badges, issue boxes ≥ 4.5:1 in both themes.

## 5. Typography
- System UI stack (no web-font download; works offline).
- Scale: 12 / 13 / 14 / 16 / 18 / 22 px. Body 14 px on desktop tool surfaces, 16 px on phones.
  Nothing below 12 px. Line-height 1.5.
- Weights: 400 body, 500 labels, 600 headings and buttons, 700 brand.
- Tabular figures for every number in tables, KPIs and the replay clock.

## 6. Spacing and size
- 4/8 px scale: 4, 8, 12, 16, 24, 32.
- Density: dense-standard (8–24 px) for a tool.
- Controls: 36 px tall with a fine pointer, 44 px with a coarse pointer (touch). 8 px minimum gap.

## 7. Motion (tier: subtle)
| Token | Value | Use |
|---|---|---|
| `--dur-fast` | 120 ms | hover, press |
| `--dur-enter` | 180 ms | dialogs, panels appearing |
| `--dur-exit` | 120 ms | leaving |
| `--ease-out` | cubic-bezier(.2,.8,.2,1) | arrivals |
Only transform and opacity animate. `prefers-reduced-motion: reduce` turns motion off.
Press feedback: scale .97.

## 8. Anti-patterns for this product
- Two primary buttons in one view (Run is the only one).
- Global toolbar holding canvas-only tools.
- Color as the only signal (block types also differ by shape; badges carry words).
- Text glyphs as icons; text under 12 px; hover-only information without a visible alternative.
- Blank canvas without a next step.
