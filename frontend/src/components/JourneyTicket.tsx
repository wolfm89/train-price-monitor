import React from 'react';
import { Box, Chip, CircularProgress, IconButton, Paper, Typography, Theme } from '@mui/material';
import { alpha } from '@mui/material/styles';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import PedalBikeIcon from '@mui/icons-material/PedalBike';
import TrainIcon from '@mui/icons-material/Train';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';

import { LoyaltyCardInput, AGE_GROUP_OPTIONS, cardShortLabel } from '../utils/travelPreferences';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Journey {
  id: string;
  limitPrice: number;
  from?: string | null;
  to?: string | null;
  firstClass?: boolean | null;
  bike?: boolean | null;
  deutschlandTicketDiscount?: boolean | null;
  ageGroup?: string | null;
  loyaltyCard?: LoyaltyCardInput | null;
  journey: {
    refreshToken: string;
    departure: string;
    arrival: string;
    means: string[];
    price: number | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const formatDate = (dt: string) =>
  new Date(dt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

const formatTime = (dt: string) => new Date(dt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

const formatDuration = (dep: string, arr: string) => {
  const mins = Math.round((new Date(arr).getTime() - new Date(dep).getTime()) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

// ---------------------------------------------------------------------------
// Sx style constants
// ---------------------------------------------------------------------------

const MONO_FONT = 'IBM Plex Mono, monospace';

const ticketSx = (theme: Theme) => ({
  borderRadius: 2,
  backgroundColor: 'background.ticket',
  boxShadow: `0 0 0 1px ${theme.palette.divider}`,
});

const upperZoneSx = {
  position: 'relative',
  px: { xs: 1.5, sm: 2.5 },
  pt: 4.5,
  pb: 1.5,
};

const dotSx = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  border: '1.5px solid',
  borderColor: 'divider',
  flexShrink: 0,
};

const trackLineSx = {
  flex: 1,
  height: '2px',
  backgroundImage: (theme: Theme) =>
    `repeating-linear-gradient(90deg, ${theme.palette.divider} 0, ${theme.palette.divider} 4px, transparent 4px, transparent 8px)`,
};

const punchHoleBaseSx = {
  position: 'relative' as const,
  width: 20,
  height: 20,
  borderRadius: '50%',
  backgroundColor: 'background.default',
  flexShrink: 0,
  mx: '-10px',
  zIndex: 1,
};

// Border arc visible only on the inner (right) half — left edge of ticket
const punchHoleLeftSx = {
  ...punchHoleBaseSx,
  '&::before': {
    content: '""',
    position: 'absolute',
    inset: 0,
    borderRadius: '50%',
    border: '0.5px solid',
    borderColor: 'divider',
    clipPath: 'inset(0 0 0 50%)',
  },
};

// Border arc visible only on the inner (left) half — right edge of ticket
const punchHoleRightSx = {
  ...punchHoleBaseSx,
  '&::before': {
    content: '""',
    position: 'absolute',
    inset: 0,
    borderRadius: '50%',
    border: '0.5px solid',
    borderColor: 'divider',
    clipPath: 'inset(0 50% 0 0)',
  },
};

// ---------------------------------------------------------------------------
// Private sub-components
// ---------------------------------------------------------------------------

interface RouteHeaderProps {
  from?: string | null;
  to?: string | null;
}

function RouteHeader({ from, to }: RouteHeaderProps) {
  const stationLabelSx = {
    color: 'text.disabled',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    display: 'block',
  };

  const stationNameSx = {
    fontFamily: 'IBM Plex Sans, sans-serif',
    fontWeight: 600,
    lineHeight: 1.2,
    fontSize: { xs: '1rem', sm: '1.25rem' },
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center' }}>
      {/* Origin */}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="caption" sx={stationLabelSx}>
          From
        </Typography>
        <Typography variant="h6" sx={stationNameSx}>
          {from ?? 'Unknown'}
        </Typography>
      </Box>

      {/* Track line — desktop */}
      <Box
        sx={{
          flex: 1,
          display: { xs: 'none', sm: 'flex' },
          alignItems: 'center',
          gap: '4px',
          px: 1,
          position: 'relative',
          top: '8px',
        }}
      >
        <Box sx={dotSx} />
        <Box sx={trackLineSx} />
        <TrainIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
        <Box sx={trackLineSx} />
        <Box sx={dotSx} />
      </Box>

      {/* Arrow — mobile */}
      <Box sx={{ display: { xs: 'flex', sm: 'none' }, alignItems: 'center', px: 1, position: 'relative', top: '8px' }}>
        <Typography sx={{ color: 'text.disabled', fontSize: 18 }}>{'\u2192'}</Typography>
      </Box>

      {/* Destination */}
      <Box sx={{ flex: 1, textAlign: 'right', minWidth: 0 }}>
        <Typography variant="caption" sx={stationLabelSx}>
          To
        </Typography>
        <Typography variant="h6" sx={stationNameSx}>
          {to ?? 'Unknown'}
        </Typography>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------

interface TimeBlockProps {
  label: string;
  date: string;
  time: string;
  disabled?: boolean;
  align?: 'left' | 'right';
}

function TimeBlock({ label, date, time, disabled = false, align = 'left' }: TimeBlockProps) {
  return (
    <Box sx={{ textAlign: align }}>
      <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block', mb: 0.25 }}>
        {date}
      </Typography>
      <Typography
        sx={{
          fontFamily: MONO_FONT,
          fontSize: { xs: 18, sm: 22 },
          fontWeight: 500,
          lineHeight: 1,
          ...(disabled && { color: 'text.disabled', letterSpacing: '0.05em' }),
        }}
      >
        {time}
      </Typography>
      <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block', mt: 0.25 }}>
        {label}
      </Typography>
    </Box>
  );
}

// ---------------------------------------------------------------------------

interface TimesRowProps {
  journey: Journey['journey'];
}

function TimesRow({ journey }: TimesRowProps) {
  const rowSx = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mt: 1.5 };

  if (journey === null) {
    return (
      <Box sx={rowSx}>
        <TimeBlock label="Departure" date={'\u2014'} time="--:--" disabled />
        <Chip
          icon={<WarningAmberIcon sx={{ fontSize: '14px !important' }} />}
          label="No longer tracked"
          size="small"
          color="warning"
          variant="outlined"
          sx={{ alignSelf: 'center', fontWeight: 500, fontSize: 11 }}
        />
        <TimeBlock label="Arrival" date={'\u2014'} time="--:--" disabled align="right" />
      </Box>
    );
  }

  return (
    <Box sx={rowSx}>
      <TimeBlock label="Departure" date={formatDate(journey.departure)} time={formatTime(journey.departure)} />
      <Chip
        icon={<AccessTimeIcon sx={{ fontSize: '12px !important' }} />}
        label={formatDuration(journey.departure, journey.arrival)}
        size="small"
        variant="outlined"
        sx={{ alignSelf: 'center', fontWeight: 500, fontSize: 11 }}
      />
      <TimeBlock label="Arrival" date={formatDate(journey.arrival)} time={formatTime(journey.arrival)} align="right" />
    </Box>
  );
}

// ---------------------------------------------------------------------------

function PerforationDivider() {
  return (
    <Box sx={{ position: 'relative', display: 'flex', alignItems: 'center', my: 0.5 }}>
      <Box sx={punchHoleLeftSx} />
      <Box sx={{ flex: 1, borderTop: '1.5px dashed', borderColor: 'divider', mx: '2px' }} />
      <Box sx={punchHoleRightSx} />
    </Box>
  );
}

// ---------------------------------------------------------------------------

interface TicketStubProps {
  journey: NonNullable<Journey['journey']>;
  limitPrice: number;
  firstClass?: boolean | null;
  bike?: boolean | null;
  deutschlandTicketDiscount?: boolean | null;
  ageGroup?: string | null;
  loyaltyCard?: LoyaltyCardInput | null;
}

function TicketStub({
  journey,
  limitPrice,
  firstClass,
  bike,
  deutschlandTicketDiscount,
  ageGroup,
  loyaltyCard,
}: TicketStubProps) {
  const underLimit = journey.price !== null && journey.price <= limitPrice;
  const diff = journey.price !== null ? Math.abs(limitPrice - journey.price).toFixed(2) : '0.00';
  const priceColor = journey.price !== null ? (underLimit ? 'success.main' : 'error.main') : 'text.disabled';

  // Build options pills
  const ageGroupLabel =
    ageGroup && ageGroup !== 'ADULT' ? (AGE_GROUP_OPTIONS.find((o) => o.value === ageGroup)?.label ?? ageGroup) : null;

  const neutralPillSx = (theme: Theme) => ({
    height: 20,
    fontSize: 11,
    fontWeight: 500,
    borderRadius: '10px',
    backgroundColor: alpha(theme.palette.text.disabled, 0.1),
    color: 'text.secondary',
    border: 'none',
    '& .MuiChip-label': { px: '7px' },
  });

  const cardPillSx = (theme: Theme) => ({
    height: 20,
    fontSize: 11,
    fontWeight: 500,
    borderRadius: '10px',
    backgroundColor: alpha(theme.palette.info.main, 0.12),
    color: 'info.main',
    border: 'none',
    '& .MuiChip-label': { px: '7px' },
  });

  const dtPillSx = (theme: Theme) => ({
    height: 20,
    fontSize: 11,
    fontWeight: 500,
    borderRadius: '10px',
    backgroundColor: alpha(theme.palette.secondary.main, 0.14),
    color: 'secondary.dark',
    border: 'none',
    '& .MuiChip-label': { px: '7px' },
  });

  const hasOptions =
    (firstClass !== undefined && firstClass !== null) ||
    loyaltyCard ||
    deutschlandTicketDiscount ||
    bike ||
    ageGroupLabel;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        px: { xs: 1.5, sm: 2.5 },
        py: 1.5,
        gap: { xs: 1.5, sm: 2 },
      }}
    >
      {/* Left: means of transport + options */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
        {journey.means.map((mean, i) => (
          <React.Fragment key={i}>
            {i > 0 && <Typography sx={{ fontSize: 10, color: 'text.disabled' }}>{'\u203A'}</Typography>}
            <Chip
              label={mean === 'walk' ? '\u{1F6B6}' : mean}
              size="small"
              sx={{ height: 22, fontSize: 11, fontWeight: 500, borderRadius: '4px' }}
            />
          </React.Fragment>
        ))}

        {hasOptions && (
          <>
            {/* Thin vertical rule separating train chain from options */}
            <Box
              sx={(theme) => ({
                width: '1px',
                height: 14,
                backgroundColor: theme.palette.divider,
                mx: 0.5,
                flexShrink: 0,
              })}
            />

            {/* Travel class */}
            {firstClass !== undefined && firstClass !== null && (
              <Chip label={firstClass ? '1st class' : '2nd class'} size="small" sx={neutralPillSx} />
            )}

            {/* Age group (non-adult) */}
            {ageGroupLabel && <Chip label={ageGroupLabel} size="small" sx={neutralPillSx} />}

            {/* Loyalty card */}
            {loyaltyCard && <Chip label={cardShortLabel(loyaltyCard)} size="small" sx={cardPillSx} />}

            {/* D-Ticket */}
            {deutschlandTicketDiscount && <Chip label="D-Ticket" size="small" sx={dtPillSx} />}

            {/* Bike */}
            {bike && (
              <Chip
                icon={<PedalBikeIcon sx={{ fontSize: '12px !important' }} />}
                label="Bike"
                size="small"
                sx={neutralPillSx}
              />
            )}
          </>
        )}
      </Box>

      {/* Price block */}
      <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
        <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block' }}>
          Limit: &euro;{limitPrice.toFixed(2)}
        </Typography>
        <Typography
          sx={{
            fontFamily: MONO_FONT,
            fontSize: { xs: 18, sm: 20 },
            fontWeight: 500,
            lineHeight: 1.1,
            color: priceColor,
          }}
        >
          {journey.price !== null ? `\u20AC${journey.price.toFixed(2)}` : 'n/a'}
        </Typography>
        {journey.price !== null && (
          <Typography variant="caption" sx={{ color: priceColor, display: 'block', fontWeight: 500 }}>
            {underLimit ? `\u2193 \u20AC${diff} under limit` : `\u2191 \u20AC${diff} over limit`}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------

function NoTrackBanner() {
  return (
    <Box
      sx={(theme) => ({
        backgroundColor: alpha(theme.palette.warning.main, 0.08),
        borderTop: '1px solid',
        borderColor: alpha(theme.palette.warning.main, 0.3),
        px: { xs: 1.5, sm: 2.5 },
        py: 1.5,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1,
        borderRadius: '0 0 8px 8px',
      })}
    >
      <WarningAmberIcon sx={{ fontSize: 16, color: 'warning.main', mt: '1px', flexShrink: 0 }} />
      <Typography variant="body2" sx={{ color: 'warning.dark' }}>
        This journey can no longer be tracked &mdash; it may have been cancelled or rescheduled. You can safely remove
        it from your watchlist.
      </Typography>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface JourneyTicketProps {
  monitor: Journey;
  onOpenMenu: (el: HTMLElement, id: string) => void;
  loadingIds: Set<string>;
  showMenu?: boolean;
}

export default function JourneyTicket({ monitor, onOpenMenu, loadingIds, showMenu = true }: JourneyTicketProps) {
  const { id, limitPrice, from, to, journey, firstClass, bike, deutschlandTicketDiscount, ageGroup, loyaltyCard } =
    monitor;

  return (
    <Box sx={{ position: 'relative' }}>
      <Paper elevation={0} sx={ticketSx}>
        {/* Upper zone */}
        <Box sx={upperZoneSx}>
          {showMenu && (
            <IconButton
              aria-label="more options"
              size="small"
              disabled={loadingIds.has(id)}
              onClick={(e) => onOpenMenu(e.currentTarget, id)}
              sx={{
                position: 'absolute',
                top: 8,
                right: 8,
                width: 28,
                height: 28,
                color: 'text.disabled',
                '&:hover': { color: 'text.primary' },
              }}
            >
              {loadingIds.has(id) ? <CircularProgress size={14} /> : <MoreVertIcon sx={{ fontSize: 18 }} />}
            </IconButton>
          )}

          <RouteHeader from={from} to={to} />
          <TimesRow journey={journey} />
        </Box>

        <PerforationDivider />

        {/* Lower zone */}
        {journey !== null ? (
          <TicketStub
            journey={journey}
            limitPrice={limitPrice}
            firstClass={firstClass}
            bike={bike}
            deutschlandTicketDiscount={deutschlandTicketDiscount}
            ageGroup={ageGroup}
            loyaltyCard={loyaltyCard}
          />
        ) : (
          <NoTrackBanner />
        )}
      </Paper>
    </Box>
  );
}
