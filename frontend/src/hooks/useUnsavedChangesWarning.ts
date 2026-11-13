import { useCallback, useRef } from 'react';
import { useBeforeUnload, useBlocker } from 'react-router-dom';

export interface UnsavedChangesWarning {
  blocked: boolean;
  proceed: () => void;
  reset: () => void;
}

/**
 * Warns about unsaved changes on reload/close and on in-app navigation.
 * Requires the app to run on a data router (`RouterProvider`).
 */
export default function useUnsavedChangesWarning(
  when: boolean,
  message = 'You have unsaved changes. Leave this page?'
): UnsavedChangesWarning {
  const whenRef = useRef(when);
  whenRef.current = when;

  useBeforeUnload((event) => {
    if (!whenRef.current) return;
    event.preventDefault();
    event.returnValue = message;
  });

  // Use a function blocker so a navigation reads the latest `when` value even
  // before React has re-registered the blocker after a state update.
  const shouldBlock = useCallback(() => whenRef.current, []);
  const blocker = useBlocker(shouldBlock);

  return {
    blocked: blocker.state === 'blocked',
    proceed: () => blocker.proceed?.(),
    reset: () => blocker.reset?.(),
  };
}
