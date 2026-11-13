import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBeforeUnload, useBlocker } from 'react-router-dom';
import useUnsavedChangesWarning from './useUnsavedChangesWarning';

vi.mock('react-router-dom', () => ({
  useBeforeUnload: vi.fn(),
  useBlocker: vi.fn(),
}));

const mockedUseBeforeUnload = vi.mocked(useBeforeUnload);
const mockedUseBlocker = vi.mocked(useBlocker);

describe('useUnsavedChangesWarning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the blocked state and wires proceed/reset', () => {
    const proceed = vi.fn();
    const reset = vi.fn();
    mockedUseBlocker.mockReturnValue({ state: 'blocked', proceed, reset } as unknown as ReturnType<typeof useBlocker>);

    const { result } = renderHook(() => useUnsavedChangesWarning(true));

    expect(result.current.blocked).toBe(true);
    result.current.proceed();
    result.current.reset();
    expect(proceed).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
  });

  it('does not block when the form is clean', () => {
    mockedUseBlocker.mockReturnValue({ state: 'unblocked' } as unknown as ReturnType<typeof useBlocker>);

    const { result } = renderHook(() => useUnsavedChangesWarning(false));

    expect(result.current.blocked).toBe(false);
  });

  it('warns before an unload only while dirty', () => {
    mockedUseBlocker.mockReturnValue({ state: 'unblocked' } as unknown as ReturnType<typeof useBlocker>);

    renderHook(() => useUnsavedChangesWarning(true, 'Leave?'));

    const unloadCallback = mockedUseBeforeUnload.mock.calls[0]?.[0];
    expect(unloadCallback).toBeTypeOf('function');

    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    Object.defineProperty(event, 'returnValue', { writable: true, value: '' });
    unloadCallback?.(event);

    expect(event.defaultPrevented).toBe(true);
    expect(event.returnValue).toBe('Leave?');
  });
});
