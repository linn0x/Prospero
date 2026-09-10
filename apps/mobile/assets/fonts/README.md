# Terminal font

`JetBrainsMonoNerdFontMono-Regular.ttf` is the monospaced icon variant of
JetBrains Mono 2.304, patched by Nerd Fonts v3.4.0. The terminal embeds this
font in its local WebView document; no network or native rebuild is required.
Bold and italic are synthesized by the WebView.

Source: https://github.com/ryanoasis/nerd-fonts/blob/v3.4.0/patched-fonts/JetBrainsMono/Ligatures/Regular/JetBrainsMonoNerdFontMono-Regular.ttf

License: SIL Open Font License 1.1, reproduced in `JetBrainsMono-OFL.txt`.

Regenerate the local terminal document after changing this asset:

```sh
node apps/mobile/scripts/build-terminal-html.mjs
```
