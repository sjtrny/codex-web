from __future__ import annotations

import math
from pathlib import Path

import cairo


WIDTH = 1200
HEIGHT = 440

BG = (0.976, 0.976, 0.968)
INK = (0.075, 0.094, 0.125)
MUTED = (0.37, 0.42, 0.49)
LINE = (0.43, 0.49, 0.57)
BORDER = (0.48, 0.53, 0.60)
BLUE = (0.15, 0.36, 0.78)
BLUE_PALE = (0.91, 0.94, 1.0)
TEAL = (0.05, 0.47, 0.43)
TEAL_PALE = (0.89, 0.97, 0.95)
AMBER = (0.55, 0.29, 0.0)
AMBER_PALE = (1.0, 0.96, 0.86)
WHITE = (1.0, 1.0, 1.0)


def rounded_rect(
    ctx: cairo.Context,
    x: float,
    y: float,
    width: float,
    height: float,
    radius: float,
) -> None:
    ctx.new_sub_path()
    ctx.arc(x + width - radius, y + radius, radius, -math.pi / 2, 0)
    ctx.arc(x + width - radius, y + height - radius, radius, 0, math.pi / 2)
    ctx.arc(x + radius, y + height - radius, radius, math.pi / 2, math.pi)
    ctx.arc(x + radius, y + radius, radius, math.pi, math.pi * 1.5)
    ctx.close_path()


def text(
    ctx: cairo.Context,
    value: str,
    x: float,
    baseline: float,
    size: float,
    color=INK,
    *,
    centered: bool = False,
) -> None:
    ctx.select_font_face(
        "sans-serif",
        cairo.FONT_SLANT_NORMAL,
        cairo.FONT_WEIGHT_NORMAL,
    )
    ctx.set_font_size(size)
    extents = ctx.text_extents(value)
    if centered:
        x -= extents.x_bearing + extents.width / 2
    ctx.set_source_rgb(*color)
    ctx.move_to(x, baseline)
    ctx.show_text(value)


def arrow(ctx: cairo.Context, points: list[tuple[float, float]], color=LINE) -> None:
    ctx.save()
    ctx.set_source_rgb(*color)
    ctx.set_line_width(3)
    ctx.set_line_cap(cairo.LineCap.ROUND)
    ctx.set_line_join(cairo.LineJoin.ROUND)
    ctx.move_to(*points[0])
    for point in points[1:]:
        ctx.line_to(*point)
    ctx.stroke()

    x, y = points[-1]
    previous_x, previous_y = points[-2]
    dx = x - previous_x
    dy = y - previous_y
    length = math.hypot(dx, dy)
    ux = dx / length
    uy = dy / length
    base_x = x - ux * 9
    base_y = y - uy * 9
    perpendicular_x = -uy * 6
    perpendicular_y = ux * 6
    ctx.move_to(base_x + perpendicular_x, base_y + perpendicular_y)
    ctx.line_to(x, y)
    ctx.line_to(base_x - perpendicular_x, base_y - perpendicular_y)
    ctx.stroke()
    ctx.restore()


def card(
    ctx: cairo.Context,
    x: float,
    y: float,
    width: float,
    height: float,
    fill=WHITE,
) -> None:
    ctx.set_source_rgba(0.08, 0.11, 0.16, 0.08)
    rounded_rect(ctx, x, y + 4, width, height, 16)
    ctx.fill()
    ctx.set_source_rgb(*fill)
    rounded_rect(ctx, x, y, width, height, 16)
    ctx.fill_preserve()
    ctx.set_source_rgb(*BORDER)
    ctx.set_line_width(2)
    ctx.stroke()


def terminal_icon(ctx: cairo.Context, x: float, y: float) -> None:
    ctx.set_source_rgb(*INK)
    rounded_rect(ctx, x, y, 48, 48, 11)
    ctx.fill()
    ctx.set_source_rgb(*WHITE)
    ctx.set_line_width(2.5)
    ctx.set_line_cap(cairo.LineCap.ROUND)
    ctx.move_to(x + 13, y + 16)
    ctx.line_to(x + 20, y + 23)
    ctx.line_to(x + 13, y + 30)
    ctx.move_to(x + 25, y + 31)
    ctx.line_to(x + 35, y + 31)
    ctx.stroke()


def browser_icon(ctx: cairo.Context, x: float, y: float) -> None:
    ctx.set_source_rgb(*BLUE_PALE)
    rounded_rect(ctx, x, y, 48, 48, 11)
    ctx.fill_preserve()
    ctx.set_source_rgb(*BLUE)
    ctx.set_line_width(2)
    ctx.stroke()
    ctx.move_to(x, y + 13)
    ctx.line_to(x + 48, y + 13)
    ctx.stroke()
    for offset in (9, 16, 23):
        ctx.arc(x + offset, y + 7, 1.5, 0, math.tau)
        ctx.fill()
    rounded_rect(ctx, x + 11, y + 21, 25, 10, 5)
    ctx.stroke()
    rounded_rect(ctx, x + 20, y + 34, 17, 6, 3)
    ctx.stroke()


def folder_icon(ctx: cairo.Context, x: float, y: float) -> None:
    ctx.set_source_rgb(*AMBER)
    ctx.set_line_width(2.5)
    ctx.move_to(x, y + 12)
    ctx.line_to(x + 17, y + 12)
    ctx.line_to(x + 23, y + 5)
    ctx.line_to(x + 47, y + 5)
    ctx.line_to(x + 47, y + 39)
    ctx.line_to(x, y + 39)
    ctx.close_path()
    ctx.stroke_preserve()
    ctx.set_source_rgba(*AMBER, 0.10)
    ctx.fill()


def draw(surface_factory, width: int = WIDTH, height: int = HEIGHT):
    surface = surface_factory(width, height)
    ctx = cairo.Context(surface)

    ctx.set_source_rgb(*BG)
    ctx.paint()

    ctx.set_source_rgb(*LINE)
    ctx.set_line_width(1.5)
    ctx.set_dash([6, 7])
    rounded_rect(ctx, 495, 55, 685, 350, 24)
    ctx.stroke()
    ctx.set_dash([])

    text(ctx, "USE EITHER - OR BOTH", 140, 236, 15, MUTED, centered=True)
    text(ctx, "WORK ENVIRONMENT  /  HOST OR CONTAINER", 523, 84, 15, MUTED)

    arrow(ctx, [(250, 160), (475, 160), (475, 213), (530, 213)], BLUE)
    arrow(ctx, [(250, 300), (275, 300)], BLUE)
    arrow(ctx, [(475, 300), (510, 300), (510, 247), (530, 247)], BLUE)
    arrow(ctx, [(700, 230), (760, 230)], TEAL)
    arrow(ctx, [(965, 230), (1025, 230)], LINE)

    card(ctx, 30, 114, 220, 92)
    terminal_icon(ctx, 50, 136)
    text(ctx, "Codex CLI", 116, 168, 22, INK)

    card(ctx, 30, 254, 220, 92)
    browser_icon(ctx, 50, 276)
    text(ctx, "Web browser", 116, 309, 20, INK)

    card(ctx, 275, 254, 200, 92, BLUE_PALE)
    text(ctx, "Codex Web", 375, 309, 21, INK, centered=True)

    card(ctx, 530, 162, 170, 136, TEAL_PALE)
    text(ctx, "Unix socket", 615, 238, 22, INK, centered=True)

    ctx.set_source_rgba(0.08, 0.11, 0.16, 0.16)
    rounded_rect(ctx, 760, 166, 205, 136, 17)
    ctx.fill()
    ctx.set_source_rgb(*INK)
    rounded_rect(ctx, 760, 162, 205, 136, 17)
    ctx.fill()
    text(ctx, "CODEX", 862.5, 216, 13, (0.66, 0.75, 0.91), centered=True)
    text(ctx, "app-server", 862.5, 251, 23, WHITE, centered=True)

    card(ctx, 1025, 162, 140, 136, AMBER_PALE)
    folder_icon(ctx, 1072, 184)
    text(ctx, "file system", 1095, 270, 19, INK, centered=True)

    text(
        ctx,
        "One backend keeps terminal and web conversations in sync.",
        837.5,
        366,
        17,
        MUTED,
        centered=True,
    )

    return surface, width, height


def render(output: Path | None = None) -> Path:
    output = output or Path(__file__).with_suffix(".png")
    surface, _, _ = draw(
        lambda width, height: cairo.ImageSurface(cairo.FORMAT_ARGB32, width, height)
    )
    surface.write_to_png(str(output))
    surface.finish()
    return output


if __name__ == "__main__":
    print(render())
