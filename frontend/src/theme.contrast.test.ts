import { describe, expect, it } from 'vitest';
import { theme } from './theme';

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const red = channel(Number.parseInt(value.slice(0, 2), 16));
  const green = channel(Number.parseInt(value.slice(2, 4), 16));
  const blue = channel(Number.parseInt(value.slice(4, 6), 16));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function blend(foreground: string, background: string, alpha: number): string {
  const parse = (hex: string) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const [fr, fg, fb] = parse(foreground);
  const [br, bg, bb] = parse(background);
  const mix = (front: number, back: number) => Math.round(front * alpha + back * (1 - alpha));
  return `#${[mix(fr, br), mix(fg, bg), mix(fb, bb)].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

describe('theme contrast', () => {
  it('keeps informative disabled-token text above 4.5:1', () => {
    const foreground = theme.palette.text.disabled;
    expect(contrastRatio(foreground, theme.palette.background.default)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(foreground, theme.palette.background.ticket)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps positive secondary text above 4.5:1', () => {
    expect(contrastRatio(theme.palette.secondary.dark, theme.palette.background.paper)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps warning text above 4.5:1', () => {
    expect(contrastRatio(theme.palette.warning.dark, theme.palette.background.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.palette.warning.dark, theme.palette.background.ticket)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the loyalty-card pill text above 4.5:1', () => {
    const tint = blend(theme.palette.info.main, theme.palette.background.ticket, 0.12);
    expect(contrastRatio(theme.palette.info.dark, tint)).toBeGreaterThanOrEqual(4.5);
  });
});
