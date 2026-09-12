# LRC Visualizer

[简体中文](./README.zh-CN.md) · **English**

Time lyrics, design visuals, and export finished videos in the browser. All assets are processed locally.

[Open the app](https://y1ch3nq.github.io/lrc-visualizer/)

## Video examples

| Single-line lyric | TikTok monochrome word reveal |
| --- | --- |
| [![Play the single-line lyric example](public/examples/single-line-wave-cover.png)](https://y1ch3nq.github.io/lrc-visualizer/examples/single-line-wave.mp4) | [![Play the TikTok word-reveal example](public/examples/tiktok-word-reveal-cover.png)](https://y1ch3nq.github.io/lrc-visualizer/examples/tiktok-word-reveal.mp4) |
| Click a cover to play | Click a cover to play |

## How to use

1. Import audio and an LRC file, or paste plain lyrics into the timing editor.
2. Refine line, ending, or word-level timing.
3. Choose a visual style, aspect ratio, fonts, colors, and background.
4. Preview and export the full video or a selected range.

## Visual styles

| Style | Character |
| --- | --- |
| Classic scrolling | Multi-line scrolling with line highlighting |
| Soda Music card | Card layout focused on the current lyric |
| Single-line wave | Soft whole-line motion with an optional speed ramp |
| TikTok monochrome | Three-line pagination with word reveals |

Supports `16:9`, `9:16`, and `1:1`, plus custom fonts, image backgrounds, local palette extraction, and a beat-reactive bar.

## Export

Opaque projects prefer MP4. Transparent projects export VP9 Alpha WebM. TikTok mode can also export a word-reveal PNG sequence ZIP. Use a current Chromium/Chrome release for transparent export.

## Run locally

```bash
npm install
npm run dev
```

On macOS, you can also run `start-dev.command`. Use `npm run build` for a production build.
