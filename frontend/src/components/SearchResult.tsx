import React, { useContext, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Typography,
  Button,
  Box,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  InputAdornment,
  CircularProgress,
  Chip,
  Paper,
} from '@mui/material';
import { Train as TrainIcon } from '@mui/icons-material';
import NavigateBeforeIcon from '@mui/icons-material/NavigateBefore';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import { Link } from 'react-router-dom';
import { useMutation } from 'urql';

import { MonitorJourney } from '../api/journey';
import { AuthContext } from '../providers/AuthProvider';
import useAlert from '../hooks/useAlert';
import { AlertSeverity } from '../providers/AlertProvider';
import { JourneySearchOptions } from './SearchMask';
import VisuallyHidden from './VisuallyHidden';
import { formatCurrency, formatDuration, formatTime } from '../utils/format';

export interface Journey {
  refreshToken: string;
  fromId: string;
  toId: string;
  departure: string;
  arrival: string;
  means: string[];
  price?: number;
}

interface Props {
  searchResult: Journey[];
  searchOptions?: JourneySearchOptions;
  onNavigateEarlier?: () => void;
  onNavigateLater?: () => void;
  navigatingDirection?: 'earlier' | 'later' | null;
}

const MONO_FONT = '"IBM Plex Mono", monospace';

// Both action states share a minimum 71px width; the loading state swaps the
// label for a spinner, so the right-hand column stays near 153px (68px price +
// 14px gap + 71px button). A growing loading label would shift the centred
// route-line icon on rows that have a price.
const ACTION_BUTTON_SX = {
  minWidth: 71,
  minHeight: { xs: 44, sm: 32 },
  boxSizing: 'border-box',
  border: '1.5px solid',
  borderRadius: '7px',
  px: 1.25,
  py: 0.5,
  fontSize: 12,
  fontWeight: 700,
  textTransform: 'none',
  whiteSpace: 'nowrap',
} as const;

const MAX_INTEGER_DIGITS = 9;

function parseLimitPrice(raw: string): number {
  return Number.parseFloat(raw.trim().replace(/[.,]/g, '.'));
}

/**
 * Keeps the limit field to one positive decimal amount. Letters, signs, spaces
 * and extra separators are removed; the user may still type a partial value
 * such as `42.` while entering the decimals.
 *
 * A pasted value may use thousands grouping (`1.234,56` or `1,234.56`); the
 * paste path recognises that and normalises it to a plain decimal. Typing uses
 * the first separator as the decimal point so that a second separator cannot
 * silently multiply the amount.
 */
function sanitizeLimitPrice(raw: string, fromPaste = false): string {
  const cleaned = raw.normalize('NFKC').replace(/[^\d.,]/g, '');
  if (cleaned === '') return '';

  if (fromPaste) {
    const separatorIndex = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));
    if (separatorIndex === -1) return cleaned.slice(0, MAX_INTEGER_DIGITS);

    const separatorCount = (cleaned.match(/[.,]/g) ?? []).length;
    const whole = cleaned.slice(0, separatorIndex).replace(/[.,]/g, '');
    const fraction = cleaned.slice(separatorIndex + 1).replace(/[.,]/g, '');
    const treatAsGrouping = separatorCount > 1 ? fraction.length !== 2 : fraction.length === 3 && whole !== '0';

    if (treatAsGrouping) {
      return `${whole}${fraction}`.slice(0, MAX_INTEGER_DIGITS);
    }
    return `${whole.slice(0, MAX_INTEGER_DIGITS)}${cleaned[separatorIndex]}${fraction.slice(0, 2)}`;
  }

  const separatorIndex = cleaned.search(/[.,]/);
  if (separatorIndex === -1) return cleaned.slice(0, MAX_INTEGER_DIGITS);

  // A dot plus a comma usually means a grouped amount; treat the last one as
  // the decimal separator so typing "1.234,56" does not become "1.23".
  if (cleaned.includes('.') && cleaned.includes(',')) {
    const last = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));
    const whole = cleaned.slice(0, last).replace(/[.,]/g, '');
    const fraction = cleaned
      .slice(last + 1)
      .replace(/[.,]/g, '')
      .slice(0, 2);
    return `${whole.slice(0, MAX_INTEGER_DIGITS)}${cleaned[last]}${fraction}`;
  }

  const separator = cleaned[separatorIndex];
  const whole = cleaned.slice(0, separatorIndex).slice(0, MAX_INTEGER_DIGITS);
  const rawFraction = cleaned.slice(separatorIndex + 1).replace(/[.,]/g, '');

  // Typing "1.234" is the start of a grouped amount such as "1.234,56", not a
  // three-decimal number. Promote the group so the user can continue with the
  // decimal comma instead of being blocked at "1.23".
  if (whole !== '' && Number(whole) !== 0 && rawFraction.length === 3) {
    return `${whole}${rawFraction}`.slice(0, MAX_INTEGER_DIGITS);
  }

  return `${whole}${separator}${rawFraction.slice(0, 2)}`;
}

const SearchResult: React.FC<Props> = ({
  searchResult,
  searchOptions,
  onNavigateEarlier,
  onNavigateLater,
  navigatingDirection,
}) => {
  const { addAlert } = useAlert();
  const [openModal, setOpenModal] = useState(false);
  const [selectedJourney, setSelectedJourney] = useState<Journey | null>(null);
  const [limitPrice, setLimitPrice] = useState('');
  const [limitError, setLimitError] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const limitPriceRef = useRef<HTMLInputElement>(null);
  const { user } = useContext(AuthContext);
  const [, monitorJourney] = useMutation(MonitorJourney);
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  // refreshToken -> JourneyMonitor id, so a row that was just watched can link
  // straight to its ticket at /journeys#<id>. Keyed by token because it is
  // unique per search result and survives in-app Earlier/Later paging while this
  // component stays mounted. A re-search or reload remounts SearchResult and
  // resets the map, so the row offers "+ Watch" again.
  const [addedJourneyIds, setAddedJourneyIds] = useState<Record<string, string>>({});
  // The row's button is unmounted and replaced by the link, so move focus to the
  // link once the dialog's focus trap has released it. Otherwise a keyboard user
  // is dropped back to the top of the page after confirming.
  const [focusToken, setFocusToken] = useState<string | null>(null);
  const addedLinkRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    if (!focusToken) return;
    const timeout = window.setTimeout(() => {
      addedLinkRefs.current[focusToken]?.focus();
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [focusToken]);

  const isPending = (refreshToken: string) => pendingToken === refreshToken;

  // Validate while the user is still typing, but only after a short pause so
  // intermediate values ("4" on the way to "42.50") do not flag every keystroke.
  useEffect(() => {
    if (!openModal) return undefined;
    if (limitPrice.trim() === '' || /[.,]$/.test(limitPrice)) {
      setLimitError(false);
      return undefined;
    }

    const timeout = window.setTimeout(() => {
      const parsed = parseLimitPrice(limitPrice);
      setLimitError(!Number.isFinite(parsed) || parsed <= (selectedJourney?.price ?? 0));
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [limitPrice, openModal, selectedJourney?.price]);

  useEffect(() => {
    if (submitError && pendingToken === null) {
      limitPriceRef.current?.focus();
    }
  }, [submitError, pendingToken]);

  const handleWatchClick = (journey: Journey) => {
    setSelectedJourney(journey);
    setLimitPrice('');
    setLimitError(false);
    setSubmitError('');
    setOpenModal(true);
  };

  const handleCloseModal = () => {
    if (pendingToken) return;
    setOpenModal(false);
  };

  const resetDialog = () => {
    setSelectedJourney(null);
    setLimitPrice('');
    setLimitError(false);
    setSubmitError('');
  };

  const handleConfirmWatch = () => {
    if (pendingToken || !selectedJourney) return;
    if (!isValidLimitPrice()) {
      setLimitError(true);
      limitPriceRef.current?.focus();
      return;
    }

    const { refreshToken, departure, fromId, toId } = selectedJourney;
    setPendingToken(refreshToken);
    setSubmitError('');
    const expires = new Date(departure);
    expires.setHours(expires.getHours() - 1);

    monitorJourney({
      userId: user?.['custom:id'],
      refreshToken: refreshToken,
      limitPrice: parseLimitPrice(limitPrice),
      expires: expires,
      fromId: fromId,
      toId: toId,
      departure: departure,
      options: searchOptions,
    })
      .then((result) => {
        if (result.error) {
          setSubmitError('Could not save the limit. Please try again.');
          return;
        }

        const journeyId = result.data?.monitorJourney?.id;
        if (!journeyId) {
          // A success response without an id cannot produce a deeplink. Treat
          // it as a failure instead of claiming success and leaving "+ Watch"
          // active, which would invite a duplicate.
          setSubmitError('Could not save the limit. Please try again.');
          return;
        }

        setAddedJourneyIds((prev) => ({ ...prev, [refreshToken]: journeyId }));
        setFocusToken(refreshToken);
        setOpenModal(false);
        addAlert('Journey successfully added to watchlist!', AlertSeverity.Success);
      })
      .catch(() => {
        setSubmitError('Could not save the limit. Please try again.');
      })
      .finally(() => {
        setPendingToken(null);
      });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleConfirmWatch();
    }
  };

  const isValidLimitPrice = () => {
    const floatValue = parseLimitPrice(limitPrice);
    return Number.isFinite(floatValue) && floatValue > (selectedJourney?.price ?? 0);
  };

  const currentFare = formatCurrency(selectedJourney?.price ?? 0);
  const limitErrorMessage = `Your limit must be above the current fare of ${currentFare}.`;
  const limitHint = `Must be above ${currentFare}. Numbers only, up to 2 decimals.`;

  return (
    <>
      <Typography variant="overline" role="status" aria-live="polite" sx={{ mb: 1.25, display: 'block' }}>
        {searchResult.length} connection{searchResult.length !== 1 ? 's' : ''} found
      </Typography>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {searchResult.map((result: Journey, index: number) => (
          <Paper
            key={index}
            elevation={0}
            sx={{
              bgcolor: 'background.ticket',
              border: 1,
              borderColor: 'divider',
              borderRadius: 2,
              px: 2,
              py: 1.75,
              display: 'flex',
              alignItems: { xs: 'flex-start', sm: 'center' },
              gap: { xs: 1, sm: 1.75 },
              cursor: 'default',
              transition: 'border-color 0.15s',
              flexWrap: 'nowrap',
            }}
          >
            {/* Times */}
            <Box sx={{ minWidth: 76, flexShrink: 0 }}>
              <Typography sx={{ fontFamily: MONO_FONT, fontSize: 17, fontWeight: 500, lineHeight: 1 }}>
                {formatTime(result.departure)}
              </Typography>
              <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.25 }}>
                → {formatTime(result.arrival)}
              </Typography>
            </Box>

            {/* Route line — md+ only. At exactly 600 px the fixed time, duration and
                price columns plus this line's minimum width overflow the viewport. */}
            <Box sx={{ flex: 1, display: { xs: 'none', md: 'flex' }, alignItems: 'center', gap: '5px' }}>
              <Box sx={{ width: 5, height: 5, borderRadius: '50%', bgcolor: 'divider', flexShrink: 0 }} />
              <Box
                sx={{
                  flex: 1,
                  height: '1px',
                  backgroundImage: (theme) =>
                    `repeating-linear-gradient(90deg, ${theme.palette.divider} 0, ${theme.palette.divider} 4px, transparent 4px, transparent 8px)`,
                }}
              />
              <TrainIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
              <Box
                sx={{
                  flex: 1,
                  height: '1px',
                  backgroundImage: (theme) =>
                    `repeating-linear-gradient(90deg, ${theme.palette.divider} 0, ${theme.palette.divider} 4px, transparent 4px, transparent 8px)`,
                }}
              />
              <Box sx={{ width: 5, height: 5, borderRadius: '50%', bgcolor: 'divider', flexShrink: 0 }} />
            </Box>

            {/* Duration + means — md+ only.
                Fixed width on purpose: this is what keeps the route-line icon in
                a stable column. Its position used to depend on how wide the
                duration chip and the (variable) list of transport means were, so
                an ICE+walk+ICE row pushed the icon left of a single-train row. */}
            <Box
              sx={{
                display: { xs: 'none', md: 'flex' },
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: 1.75,
                width: 240,
                flexShrink: 0,
              }}
            >
              <Chip
                label={formatDuration(result.departure, result.arrival)}
                size="small"
                variant="outlined"
                sx={{ fontSize: 11, fontWeight: 500, height: 24, flexShrink: 0 }}
              />

              <Box
                sx={{
                  display: 'flex',
                  flex: 1,
                  justifyContent: 'flex-end',
                  gap: 0.5,
                  flexWrap: 'wrap',
                  minWidth: 0,
                }}
              >
                {result.means.map((mean: string, i: number) => (
                  <Chip
                    key={i}
                    label={mean === 'walk' ? '\u{1F6B6}' : mean}
                    size="small"
                    sx={{ height: 22, fontSize: 10, fontWeight: 700, borderRadius: '4px' }}
                  />
                ))}
              </Box>
            </Box>

            {/* Compact middle: Duration + Means — below md; flex:1 lets it grow, items wrap internally */}
            <Box
              sx={{
                display: { xs: 'flex', md: 'none' },
                flex: 1,
                flexWrap: 'wrap',
                gap: '5px',
                alignItems: 'center',
                alignContent: 'flex-start',
              }}
            >
              <Chip
                label={formatDuration(result.departure, result.arrival)}
                size="small"
                variant="outlined"
                sx={{ fontSize: 11, fontWeight: 500, height: 24 }}
              />
              {result.means.map((mean: string, i: number) => (
                <Chip
                  key={i}
                  label={mean === 'walk' ? '\u{1F6B6}' : mean}
                  size="small"
                  sx={{ height: 22, fontSize: 10, fontWeight: 700, borderRadius: '4px' }}
                />
              ))}
            </Box>

            {/* Price + Watch — fixed right column: stacked vertically on xs, inline on sm+.
                minWidth on sm+ is what completes the icon alignment: a row without a
                price has no Watch button, so its right column used to be ~85px
                narrower, the flex:1 route line grew, and its centred icon drifted
                43px to the right of every other row. */}
            <Box
              sx={{
                flexShrink: 0,
                minWidth: { xs: 'auto', md: 153 },
                display: 'flex',
                flexDirection: { xs: 'column', md: 'row' },
                alignItems: { xs: 'flex-end', md: 'center' },
                gap: { xs: 0.5, md: 1.75 },
              }}
            >
              <Box sx={{ textAlign: 'right', minWidth: { xs: 60, md: 68 } }}>
                <Typography sx={{ fontFamily: MONO_FONT, fontSize: { xs: 15, sm: 16 }, fontWeight: 500 }}>
                  {result.price != null ? formatCurrency(result.price) : 'n/a'}
                </Typography>
              </Box>

              {result.price != null &&
                (addedJourneyIds[result.refreshToken] ? (
                  <Button
                    component={Link}
                    to={`/journeys#${addedJourneyIds[result.refreshToken]}`}
                    size="small"
                    ref={(el) => {
                      addedLinkRefs.current[result.refreshToken] = el;
                    }}
                    aria-label={`View the ${formatTime(result.departure)}\u2013${formatTime(result.arrival)} ${result.means.join(' + ')} connection in your watchlist`}
                    sx={{
                      ...ACTION_BUTTON_SX,
                      bgcolor: 'success.main',
                      color: '#fff',
                      borderColor: 'success.main',
                      '&:hover': { bgcolor: 'success.dark' },
                      '&:active': { bgcolor: 'success.dark' },
                    }}
                  >
                    View {'\u2192'}
                  </Button>
                ) : (
                  <Button
                    size="small"
                    aria-disabled={isPending(result.refreshToken)}
                    aria-busy={isPending(result.refreshToken)}
                    aria-label={
                      isPending(result.refreshToken)
                        ? `Adding the ${formatTime(result.departure)} connection to your watchlist…`
                        : `Add the ${formatTime(result.departure)}\u2013${formatTime(result.arrival)} ${result.means.join(' + ')} connection to your watchlist`
                    }
                    onClick={() => {
                      if (!isPending(result.refreshToken)) handleWatchClick(result);
                    }}
                    sx={{
                      ...ACTION_BUTTON_SX,
                      bgcolor: 'secondary.light',
                      color: 'secondary.dark',
                      borderColor: 'secondary.main',
                      '&:hover': { bgcolor: 'secondary.dark', color: '#fff' },
                      '&:active': { bgcolor: 'secondary.dark', color: '#fff' },
                      '&[aria-disabled="true"]': {
                        bgcolor: 'secondary.light',
                        color: 'secondary.dark',
                        borderColor: 'secondary.main',
                        cursor: 'default',
                      },
                    }}
                  >
                    {isPending(result.refreshToken) ? <CircularProgress size={14} color="inherit" /> : '+ Watch'}
                  </Button>
                ))}
            </Box>
          </Paper>
        ))}
      </Box>

      {(onNavigateEarlier || onNavigateLater) && (
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 2, mb: 1 }}>
          {onNavigateEarlier ? (
            <Button
              variant="outlined"
              size="small"
              onClick={onNavigateEarlier}
              disabled={!!navigatingDirection}
              startIcon={navigatingDirection === 'earlier' ? <CircularProgress size={16} /> : <NavigateBeforeIcon />}
              sx={{ textTransform: 'none' }}
            >
              Earlier trains
            </Button>
          ) : (
            <span />
          )}
          {onNavigateLater && (
            <Button
              variant="outlined"
              size="small"
              onClick={onNavigateLater}
              disabled={!!navigatingDirection}
              endIcon={navigatingDirection === 'later' ? <CircularProgress size={16} /> : <NavigateNextIcon />}
              sx={{ textTransform: 'none' }}
            >
              Later trains
            </Button>
          )}
        </Box>
      )}

      {/* Watch Modal */}
      <Dialog
        open={openModal}
        onClose={handleCloseModal}
        maxWidth="xs"
        fullWidth
        slotProps={{ transition: { onExited: resetDialog } }}
      >
        <DialogTitle>Set limit price</DialogTitle>
        <DialogContent>
          <TextField
            id="limit-price"
            label="Limit price"
            name="limitPrice"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="e.g. 80.00"
            required
            fullWidth
            disabled={pendingToken !== null}
            inputRef={limitPriceRef}
            value={limitPrice}
            onChange={(e) => {
              setLimitPrice(sanitizeLimitPrice(e.target.value));
              setSubmitError('');
            }}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text');
              if (!text) return;
              e.preventDefault();
              setLimitPrice(sanitizeLimitPrice(text, true));
              setSubmitError('');
            }}
            onBlur={() => {
              if (limitPrice.trim() !== '') setLimitError(!isValidLimitPrice());
            }}
            onKeyDown={handleKeyDown}
            error={limitError}
            helperText={limitError ? limitErrorMessage : limitHint}
            sx={{ mt: 1 }}
            slotProps={{
              input: { startAdornment: <InputAdornment position="start">€</InputAdornment> },
              htmlInput: { enterKeyHint: 'done' },
            }}
          />
          <VisuallyHidden>
            <span role="status" aria-live="polite">
              {limitError ? limitErrorMessage : ''}
            </span>
          </VisuallyHidden>
          {submitError && (
            <Alert severity="error" sx={{ mt: 1.5 }}>
              {submitError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseModal} disabled={pendingToken !== null} sx={{ minHeight: { xs: 44 } }}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirmWatch}
            disabled={pendingToken !== null}
            aria-busy={pendingToken !== null}
            startIcon={pendingToken !== null ? <CircularProgress size={16} color="inherit" /> : undefined}
            sx={{ minHeight: { xs: 44 }, '&.Mui-disabled': { color: 'text.secondary' } }}
          >
            {pendingToken !== null ? 'Saving…' : 'Save limit'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default SearchResult;
