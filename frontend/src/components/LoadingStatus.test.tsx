import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import LoadingStatus from './LoadingStatus';

describe('LoadingStatus', () => {
  it('announces the loading state', () => {
    render(<LoadingStatus label="Loading journeys…" />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading journeys…');
  });

  it('keeps the label available when rendered inline', () => {
    render(<LoadingStatus label="Searching Deutsche Bahn…" inline />);

    expect(screen.getByRole('status')).toHaveTextContent('Searching Deutsche Bahn…');
  });
});
