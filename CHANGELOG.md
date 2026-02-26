# Changelog

All notable changes to this project are documented here.

## [3.0.0] — current

### Added
- **Sierpinski triangle** on home screen — recursion depth driven by `navigator.hardwareConcurrency` (Bun) / `os.cpus().length` (Node fallback). More CPU threads → deeper fractal, making hardware parallelism visually tangible.
- Half-block Unicode rendering (`▀ ▄`) for 2× vertical resolution — each terminal row encodes two logical pixel rows with independent foreground/background colours.
- Blue → green → amber gradient across fractal depth levels (apex to base).
- Depth label below fractal: `depth 4  ·  12 logical threads`.
- `getLogicalThreads()` with dual-runtime detection (Bun + Node).

## [2.0.0]

### Fixed (bugs)
- `cycleSettingBack()` was defined but never called — dead code removed; left arrow now calls `adjustSetting(sec, s, -1)`.
- Duplicate sidebar condition `screen === "settings" || screen === "settings"` removed.
- Status timer stacking: `clearTimeout` now called before each new `setTimeout`.
- Escape key ambiguity: `isEsc = hex === "1b"` (bare 3-byte only); arrow keys are `1b5b4x` sequences — no longer confused.
- Number settings were increment-only; left arrow now decrements with bounds checking.
- Export screen truncated silently; `exportScroll` state added with `↑↓` scrolling and scroll % indicator.
- `state.editingValue`/`editingKey` in interface but never wired — replaced with working `editing`, `editBuf`, `editCursor`.
- Tutorial code block off-by-one: box height was `codeH + 2` but inner render used `codeH`, leaving a blank row.
- Sidebar overflow on small terminals — sub-nav loops now capped at `Math.min(count, termH - 13)`.
- Home banner overflow on narrow terminals — column clamped with `Math.max(1, Math.floor((termW - bannerW) / 2))`.
- `P.bFoc` was an unused alias for `P.accent` (same RGB value) — removed.
- `B.lt` / `B.rt` declared but never referenced — removed.
- `adjustSetting` bool branch ignored `dir` parameter — now directional: right/+1 = enable, left/−1 = disable.
- `saveConfig()` was called without `await`; replaced with synchronous `fs.writeFileSync`.
- `generateConfig()` called 2–3× per Export keypress — result now cached in `state.configCache`, invalidated on any settings change.
- `state.exportScroll` was mutated inside `renderExport()` — clamping moved to input handler.
- `box()` title centering used `.length` instead of `visLen()` — emoji titles were off-center by 1 col per emoji.
- `greetd` display manager emitted `services.xserver.displayManager.greetd` (nonexistent) — corrected to `services.greetd.enable`.
- `hyprland` / `sway` / `river` emitted `services.xserver.windowManager.*` — corrected to `programs.*.enable`.
- `nix.settings` block always emitted `auto-optimise-store = false` — replaced with `nix.optimise.automatic = true` gated on the toggle.
- `user.homeManager` toggle had no effect on config output — now emits commented-out HM wiring block.
- `desktop.wayland` toggle had no effect on config output — now sets `defaultSession` for plasma6/gnome.
- `process.on("exit", cleanup)` caused double-fire of `showCursor + altOff` after SIGINT/SIGTERM — removed.

### Added
- User settings section (username, fullName, shell, homeManager, autologin).
- `stateVersion` setting (enum: 24.05 / 24.11 / 25.05).
- Modified indicators: `◈` next to any setting changed from default.
- Section badges in sidebar showing count of modified settings per section.
- Inline string/number editing with cursor-based input and Backspace/←→ navigation.
- Hostname validation (RFC 1123: alphanumeric + hyphens, no leading/trailing hyphen).
- Username validation (POSIX: lowercase, digits, `_`, `-`).
- Export screen: line numbers, scroll position percentage, Page Up/Down, `g`/`G` jump to top/bottom.
- Export `W` key writes config to `/tmp/configuration.nix` synchronously.
- Export `Tab` key jumps directly to Settings.
- Tutorial completion tracking: `tutorialsDone: Set<string>` persists across nav.
- Completion checkmarks `✓` shown in tutorial list view.
- `R` key resets current settings section to defaults.
- Minimum terminal size guard (80×24) with helpful error message.
- `Ctrl+C` handled in all modes.
- Richer config generation: SSH port + firewall rule, DNS resolver selection, NUR comment block, `nix.optimise.automatic`, shell package mapping, security options (AppArmor, TPM2, Secure Boot note, ASLR, Polkit).
- `v` keybinding aliases (`hjkl`) for vi-style navigation.
- Help modal (`?`) with comprehensive key reference.

## [1.0.0]

- Initial release: settings TUI with sidebar navigation, tutorial viewer, and basic config export.
