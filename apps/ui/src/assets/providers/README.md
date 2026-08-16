# Provider logos

Drop a file here named after the provider kind and it is used automatically —
no code change. `anthropic`, `openai`, `google`, `openrouter`, `ollama`,
`ollama-cloud`, `omniroute`, `lmstudio`.

    anthropic.png      or  anthropic.svg
    openai.png
    ollama.png
    omniroute.png

`ProviderMark` globs this directory at build time and falls back to a
monogram for anything missing, so a half-filled folder renders correctly
rather than showing gaps.

Square images, 512px or an SVG. They are drawn at 18px inside a 30px badge, so
anything with fine detail at that size will not read — the mark is an identity
cue, not an illustration.
