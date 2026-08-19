#!/usr/bin/env python3
"""Compose paired browser and terminal screenshots into the demo GIF."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


PANE_WIDTH = 780
PANE_HEIGHT = 600
LABEL_HEIGHT = 40
OUTPUT_WIDTH = 1200
FRAME_DURATION_MS = 160


def label_font() -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    ):
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, 17)
    return ImageFont.load_default()


def frame_paths(root: Path, pane: str) -> list[Path]:
    return sorted((root / pane).glob("*.png"))


def compose_frame(web_path: Path, cli_path: Path, font: ImageFont.ImageFont) -> Image.Image:
    width = PANE_WIDTH * 2
    height = PANE_HEIGHT + LABEL_HEIGHT
    canvas = Image.new("RGB", (width, height), "#101112")
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, width, LABEL_HEIGHT), fill="#181a1b")
    draw.line((PANE_WIDTH, 0, PANE_WIDTH, height), fill="#3b3f42", width=2)
    draw.text((16, 10), "CODEX WEB", fill="#f1f3f4", font=font)
    draw.text((PANE_WIDTH + 16, 10), "CODEX CLI", fill="#f1f3f4", font=font)

    with Image.open(web_path) as web_image, Image.open(cli_path) as cli_image:
        canvas.paste(web_image.convert("RGB"), (0, LABEL_HEIGHT))
        canvas.paste(cli_image.convert("RGB"), (PANE_WIDTH, LABEL_HEIGHT))

    output_height = round(height * OUTPUT_WIDTH / width)
    return canvas.resize((OUTPUT_WIDTH, output_height), Image.Resampling.LANCZOS)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--frames", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    web_frames = frame_paths(args.frames, "web")
    cli_frames = frame_paths(args.frames, "cli")
    if not web_frames or len(web_frames) != len(cli_frames):
        raise SystemExit("Browser and terminal frame counts must match.")

    font = label_font()
    frames = [
        compose_frame(web_path, cli_path, font)
        for web_path, cli_path in zip(web_frames, cli_frames, strict=True)
    ]
    palette = frames[0].quantize(colors=128, method=Image.Quantize.MEDIANCUT)
    encoded = [
        frame.quantize(palette=palette, dither=Image.Dither.FLOYDSTEINBERG)
        for frame in frames
    ]

    args.output.parent.mkdir(parents=True, exist_ok=True)
    encoded[0].save(
        args.output,
        save_all=True,
        append_images=encoded[1:],
        duration=FRAME_DURATION_MS,
        loop=0,
        # Preserve the prior frame so Pillow can encode only changed pixels.
        disposal=1,
        optimize=True,
    )
    print(args.output.resolve())


if __name__ == "__main__":
    main()
