import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { createMemoryRouter, Link, Route, RouterProvider, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import useUnsavedChangesWarning from './useUnsavedChangesWarning';

function Page() {
  const [dirty, setDirty] = useState(true);
  const { blocked, proceed, reset } = useUnsavedChangesWarning(dirty, 'Leave?');

  return (
    <>
      <p>{blocked ? 'blocked' : dirty ? 'dirty' : 'clean'}</p>
      <button onClick={() => setDirty(false)}>Mark clean</button>
      {blocked && (
        <>
          <button onClick={reset}>Stay</button>
          <button onClick={proceed}>Leave</button>
        </>
      )}
      <Link to="/other">Other page</Link>
      <Routes>
        <Route path="/" element={<p>Home</p>} />
        <Route path="/other" element={<p>Other</p>} />
      </Routes>
    </>
  );
}

describe('useUnsavedChangesWarning with a data router', () => {
  it('blocks navigation from a nested Routes tree until proceed', async () => {
    const router = createMemoryRouter([{ path: '*', element: <Page /> }], { initialEntries: ['/'] });
    render(<RouterProvider router={router} />);

    expect(screen.getByText('dirty')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Other page'));
    expect(await screen.findByText('blocked')).toBeInTheDocument();
    expect(screen.getByText('Home')).toBeInTheDocument();
  });
});
