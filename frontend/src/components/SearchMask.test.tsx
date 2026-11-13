import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SearchMask from './SearchMask';

const { mockReexecute } = vi.hoisted(() => ({ mockReexecute: vi.fn() }));

vi.mock('urql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('urql')>();
  return {
    ...actual,
    useQuery: () => [{ data: undefined, fetching: false }, mockReexecute],
  };
});

const futureSearch = {
  from: '8000105',
  to: '8000261',
  departure: '2030-01-15T09:00:00.000Z',
  fromName: 'Berlin Hbf',
  toName: 'München Hbf',
};

describe('SearchMask', () => {
  it('submits a hydrated search from the URL', () => {
    const onSearch = vi.fn();
    render(<SearchMask onSearch={onSearch} initialSearch={futureSearch} />);

    const fromInput = screen.getByRole('combobox', { name: 'From station' });
    fireEvent.click(screen.getByText('From'));
    expect(fromInput).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(onSearch).toHaveBeenCalledWith(
      '8000105',
      '8000261',
      expect.any(String),
      undefined,
      'Berlin Hbf',
      'München Hbf'
    );
  });

  it('uses neutral options for a URL search instead of profile defaults', async () => {
    const onSearch = vi.fn();
    render(
      <SearchMask
        onSearch={onSearch}
        initialSearch={{ ...futureSearch, options: { deutschlandTicketDiscount: false } }}
        initialWalletCards={[{ type: 'BAHNCARD', discount: 25, class: 2 }]}
        initialAgeGroup="SENIOR"
        initialDeutschlandTicketDiscount
      />
    );

    expect(screen.getByRole('combobox', { name: 'Age group' })).toHaveTextContent('Adult');

    fireEvent.click(screen.getByRole('button', { name: 'Search options' }));
    expect(await screen.findByRole('combobox', { name: 'Discount card' })).toHaveTextContent('No card');
    expect(screen.getByRole('combobox', { name: 'Max transfers' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Regional costs deducted/ })).not.toBeChecked();
  });

  it('does not submit without stations and explains what is missing', () => {
    const onSearch = vi.fn();
    render(<SearchMask onSearch={onSearch} />);

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(onSearch).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Choose a departure station.');
  });

  it('does not submit a past departure', () => {
    const onSearch = vi.fn();
    render(
      <SearchMask onSearch={onSearch} initialSearch={{ ...futureSearch, departure: '2020-01-15T09:00:00.000Z' }} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(onSearch).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Departure must be in the future.');
  });

  it('does not submit when no transport modes are selected', async () => {
    const onSearch = vi.fn();
    render(<SearchMask onSearch={onSearch} initialSearch={futureSearch} />);

    fireEvent.click(screen.getByRole('button', { name: 'Search options' }));
    expect(await screen.findByLabelText('Bicycle space')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Transport modes' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Travel class' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Clear all transport modes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(onSearch).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Select at least one transport mode.');
  });
});
