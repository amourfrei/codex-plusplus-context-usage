# Context Usage for Codex++

See your conversation context and rate-limit usage where you are already
working: directly inside the Codex desktop composer footer.

`Context Usage` is a [Codex++](https://github.com/b-nnett/codex-plusplus)
tweak that adds three quiet, native-looking indicators next to `Goal`:

```text
Goal  |  Context 44%  |  5h 46%  |  Weekly 89%
```

## What It Does

- Shows the current thread's context usage, 5-hour usage, and weekly usage.
- Turns `Context` yellow above 21% and red above 41%.
- Turns the `5h` and `Weekly` values red above 88%.
- Shows a floating `Consider /compact to reduce context` tip when context is
  above 41%.
- Hides the tip after five seconds, or immediately when you close it.
- Submits `/compact` only when you deliberately click the suggestion.

Crossing a threshold never triggers compaction by itself. Codex's own
compaction behavior remains unchanged.

## Requirements

- The Codex desktop application.
- [Codex++](https://github.com/b-nnett/codex-plusplus) runtime `0.1.6` or
  newer.

## Install

Install Codex++ first, then place this tweak in the Codex++ tweaks directory.
On macOS:

```bash
git clone https://github.com/amourfrei/codex-plusplus-context-usage.git \
  "$HOME/Library/Application Support/codex-plusplus/tweaks/co.codexpp.context-usage"
```

Tweak directory locations on other platforms:

```text
Linux:   ~/.local/share/codex-plusplus/tweaks/
Windows: %APPDATA%/codex-plusplus/tweaks/
```

Restart Codex, or leave Codex++ running while installing so its watcher loads
the new tweak. It appears as `Context Usage` in Codex++ Tweaks settings.

## Privacy And Behavior

The tweak reads local Codex session `token_count` records for the active
conversation so it can display the same context and rate-limit information
already available locally. It does not send those records anywhere.

The `/compact` suggestion is an explicit action: clicking it writes and
submits the native slash command in the composer. Dismissing it, waiting for
its timer, or merely reaching red context never submits a command.

## Development

```bash
npm install
npm test
codexplusplus validate-tweak .
codexplusplus dev .
```

The package has no runtime npm dependencies; `jsdom` is used only for renderer
tests.

## License

[MIT](LICENSE)
