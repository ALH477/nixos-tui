# Contributing

## Setup

```bash
git clone https://github.com/you/nixos-tui
cd nixos-tui
bun install        # installs dev deps (typescript, @types/node)
bun --watch run src/main.ts   # live reload during dev
```

## Architecture

The entire application lives in `src/main.ts`, deliberately a single file. The sections are:

| Section | Lines (approx) | Purpose |
|---------|----------------|---------|
| System info | ~20 | `getLogicalThreads()` — Bun + Node runtime detection |
| ANSI primitives | ~20 | `T` object: escape sequences for cursor, colour, alt-screen |
| Palette | ~20 | `P` object: 24-bit RGB colour constants |
| Box drawing | ~10 | `B` object: Unicode border/icon characters |
| Helpers | ~40 | `visLen`, `padStr`, `clip`, `box` |
| Sierpinski | ~100 | Depth mapping, fill predicate, gradient, half-block renderer |
| Data — Settings | ~150 | `SETTINGS` array of `SettingsSection` objects |
| Data — Tutorials | ~350 | `TUTORIALS` array of multi-step `Tutorial` objects |
| State | ~60 | `AppState` interface, defaults, `setStatus`, `isModified` |
| Rendering | ~400 | One `render*` function per screen |
| Config generation | ~150 | `generateConfig()` → NixOS Nix expressions |
| Input | ~150 | `handleKey`, `adjustSetting`, `toggleBool`, `beginEdit`, `commitEdit`, `saveConfig` |
| Lifecycle | ~20 | `cleanup`, `main` |

## Conventions

**Rendering** functions only build ANSI strings and `write()` them. They must not mutate `state`. The single exception was historically `state.exportScroll` being clamped in `renderExport` — this was fixed in v2 and the pattern should not recur.

**State mutation** belongs in input handlers only.

**Config invalidation** — call `invalidateConfig()` whenever any setting changes. `getConfig()` is the public accessor and caches the result.

**Colour palette** — use existing `P.*` constants. Do not add inline RGB literals. If a new colour is needed, add it to `P` with a semantic name.

**visLen vs .length** — always use `visLen()` when measuring strings that may contain ANSI escapes or multi-column Unicode (emoji). Never use `.length` for layout calculations.

## Adding a setting

1. Add a `Setting` entry to the relevant section in `SETTINGS`.
2. If it affects config output, add a branch in `generateConfig()`.
3. Call `invalidateConfig()` in any code that mutates it (already handled by `adjustSetting` / `toggleBool` / `commitEdit`).
4. If it requires validation (like hostname), add a guard in `commitEdit()`.

## Adding a tutorial

Add a `Tutorial` entry to `TUTORIALS`. Each `TutorialStep` has:
- `title: string`
- `body: string[]` — lines of prose
- `code?: string` — rendered in a syntax-highlighted box
- `tip?: string` — rendered as a 💡 tip line

## Sierpinski fractal

The fractal logic (`sierpinskiDepth`, `sierpinskiFilled`, `fractalColor`, `renderSierpinski`) is self-contained. The key invariant: depth is determined once at startup from `CPU_THREADS` and re-clamped to available terminal space on each render call from `renderHome`.

The fill predicate uses Pascal's triangle mod 2 — cell `(r, k)` is filled iff `(r & k) === k`. This is O(1) per cell and requires no recursion.

## Testing

There is no automated test suite (the UI is pure terminal output). Manual testing checklist:

- [ ] All 6 settings sections navigate correctly
- [ ] Bool, enum, number, string settings all edit correctly
- [ ] Modified indicators appear/disappear correctly
- [ ] R key resets section to defaults
- [ ] Hostname/username validation rejects bad input
- [ ] Export scrolls, saves, and reflects setting changes
- [ ] All 6 tutorials step through to completion
- [ ] Completion `✓` appears in tutorial list after finishing
- [ ] Fractal renders on terminals of varying width/height
- [ ] Ctrl+C, q, Esc all exit/navigate cleanly
- [ ] Help modal (`?`) shows and closes correctly
- [ ] Terminal resize is handled gracefully
- [ ] Too-small terminal shows error message

## Pull requests

- Keep changes focused — one logical change per PR
- Update CHANGELOG.md under `## [Unreleased]`
- Ensure `bun run check` passes before submitting
