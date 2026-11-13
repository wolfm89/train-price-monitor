import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import usePrefersReducedMotion from './usePrefersReducedMotion';

function installMatchMedia(initialMatches: boolean) {
  const listeners = new Set<() => void>();
  const mediaQuery = {
    matches: initialMatches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn((_event: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_event: string, listener: () => void) => listeners.delete(listener)),
    addListener: vi.fn((listener: () => void) => listeners.add(listener)),
    removeListener: vi.fn((listener: () => void) => listeners.delete(listener)),
  } as unknown as MediaQueryList;

  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mediaQuery)
  );

  return {
    mediaQuery,
    setMatches(matches: boolean) {
      (mediaQuery as { matches: boolean }).matches = matches;
      listeners.forEach((listener) => listener());
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('usePrefersReducedMotion', () => {
  it('returns the current media query value', () => {
    installMatchMedia(true);
    const { result } = renderHook(() => usePrefersReducedMotion());

    expect(result.current).toBe(true);
  });

  it('updates when the media query changes', () => {
    const media = installMatchMedia(false);
    const { result } = renderHook(() => usePrefersReducedMotion());

    expect(result.current).toBe(false);

    act(() => media.setMatches(true));

    expect(result.current).toBe(true);
  });
});
