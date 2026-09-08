#!/usr/bin/env python3
"""Compose paired browser and terminal screenshots into windowed demo GIF."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


PANE_WIDTH = 780
PANE_HEIGHT = 600
WINDOW_BAR_HEIGHT = 52
WINDOW_RADIUS = 12
CANVAS_PADDING = 20
WINDOW_GAP = 16
OUTPUT_WIDTH = 1200
FRAME_DURATION_MS = 160

CANVAS_WIDTH = CANVAS_PADDING * 2 + PANE_WIDTH * 2 + WINDOW_GAP
CANVAS_HEIGHT = CANVAS_PADDING * 2 + WINDOW_BAR_HEIGHT + PANE_HEIGHT


def toolbar_font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    ) if bold else (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
    )
    for candidate in candidates:
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def frame_paths(root: Path, pane: str) -> list[Path]:
    return sorted((root / pane).glob("*.png"))


def draw_window_controls(draw: ImageDraw.ImageDraw) -> None:
    for x, color in ((18, "#ff5f57"), (36, "#febc2e"), (54, "#28c840")):
        draw.ellipse((x - 6, 20, x + 6, 32), fill=color)


def browser_window(image: Image.Image, font: ImageFont.ImageFont) -> Image.Image:
    window = Image.new("RGB", (PANE_WIDTH, WINDOW_BAR_HEIGHT + PANE_HEIGHT), "#101112")
    draw = ImageDraw.Draw(window)
    draw.rectangle((0, 0, PANE_WIDTH, WINDOW_BAR_HEIGHT), fill="#222528")
    draw_window_controls(draw)

    icon_color = "#aeb4b8"
    muted_icon_color = "#676d71"
    draw.line((83, 21, 76, 26, 83, 31), fill=icon_color, width=2, joint="curve")
    draw.line((101, 21, 108, 26, 101, 31), fill=muted_icon_color, width=2, joint="curve")
    draw.arc((120, 18, 136, 34), 35, 330, fill=icon_color, width=2)
    draw.polygon(((133, 17), (138, 19), (134, 23)), fill=icon_color)

    address_box = (153, 9, PANE_WIDTH - 13, WINDOW_BAR_HEIGHT - 9)
    draw.rounded_rectangle(address_box, radius=9, fill="#141618", outline="#3b3f43", width=1)
    address = "localhost:8765"
    text_box = draw.textbbox((0, 0), address, font=font)
    text_y = (address_box[1] + address_box[3] - text_box[1] - text_box[3]) / 2
    draw.text((address_box[0] + 14, text_y), address, fill="#d7dadd", font=font)
    draw.line((0, WINDOW_BAR_HEIGHT - 1, PANE_WIDTH, WINDOW_BAR_HEIGHT - 1), fill="#34383c")
    window.paste(image.convert("RGB"), (0, WINDOW_BAR_HEIGHT))
    return window


def terminal_window(
    image: Image.Image,
    bold_font: ImageFont.ImageFont,
) -> Image.Image:
    window = Image.new("RGB", (PANE_WIDTH, WINDOW_BAR_HEIGHT + PANE_HEIGHT), "#101112")
    draw = ImageDraw.Draw(window)
    draw.rectangle((0, 0, PANE_WIDTH, WINDOW_BAR_HEIGHT), fill="#1e2124")
    draw_window_controls(draw)

    title = "Codex CLI — terminal"
    title_box = draw.textbbox((0, 0), title, font=bold_font)
    title_width = title_box[2] - title_box[0]
    draw.text(((PANE_WIDTH - title_width) / 2, 17), title, fill="#d7dadd", font=bold_font)
    draw.line((0, WINDOW_BAR_HEIGHT - 1, PANE_WIDTH, WINDOW_BAR_HEIGHT - 1), fill="#34383c")
    window.paste(image.convert("RGB"), (0, WINDOW_BAR_HEIGHT))
    return window


def paste_window(canvas: Image.Image, window: Image.Image, position: tuple[int, int]) -> None:
    x, y = position
    mask = Image.new("L", window.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, window.width - 1, window.height - 1),
        radius=WINDOW_RADIUS,
        fill=255,
    )
    canvas.paste(window, position, mask)
    ImageDraw.Draw(canvas).rounded_rectangle(
        (x, y, x + window.width - 1, y + window.height - 1),
        radius=WINDOW_RADIUS,
        outline="#41464a",
        width=1,
    )


def compose_frame(
    web_path: Path,
    cli_path: Path,
    font: ImageFont.ImageFont,
    bold_font: ImageFont.ImageFont,
) -> Image.Image:
    canvas = Image.new("RGB", (CANVAS_WIDTH, CANVAS_HEIGHT), "#0b0d0f")
    draw = ImageDraw.Draw(canvas)
    web_position = (CANVAS_PADDING, CANVAS_PADDING)
    cli_position = (CANVAS_PADDING + PANE_WIDTH + WINDOW_GAP, CANVAS_PADDING)

    for x, y in (web_position, cli_position):
        draw.rounded_rectangle(
            (x + 4, y + 7, x + PANE_WIDTH + 3, y + WINDOW_BAR_HEIGHT + PANE_HEIGHT + 6),
            radius=WINDOW_RADIUS,
            fill="#050607",
        )

    with Image.open(web_path) as web_image, Image.open(cli_path) as cli_image:
        paste_window(canvas, browser_window(web_image, font), web_position)
        paste_window(canvas, terminal_window(cli_image, bold_font), cli_position)

    output_height = round(CANVAS_HEIGHT * OUTPUT_WIDTH / CANVAS_WIDTH)
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

    font = toolbar_font(18)
    bold_font = toolbar_font(15, bold=True)
    frames = [
        compose_frame(web_path, cli_path, font, bold_font)
        for web_path, cli_path in zip(web_frames, cli_frames, strict=True)
    ]
    palette = frames[0].quantize(colors=256, method=Image.Quantize.MEDIANCUT)
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
