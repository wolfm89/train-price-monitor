import React, { useContext, useEffect, useState } from 'react';
import SignupModal from '../components/SignupModal';
import LoginModal from '../components/LoginModal';
import { Button, Typography, Box, CircularProgress, Chip, Paper, Grid } from '@mui/material';
import {
  Train as TrainIcon,
  Visibility,
  NotificationsActive,
  ConfirmationNumber,
  CheckCircleOutline,
  ErrorOutline,
  AllInclusive,
  ArrowForward,
} from '@mui/icons-material';
import { Link } from 'react-router-dom';
import { AuthContext } from '../providers/AuthProvider';
import { AlertSeverity } from '../providers/AlertProvider';
import useAlert from '../hooks/useAlert';
import { UserExistsQuery, CreateUser, UserJourneysQuery } from '../api/user';
import { useMutation, useQuery } from 'urql';
import { Journey } from '../components/JourneyTicket';

interface Props {}

// ---------------------------------------------------------------------------
// Feature card — logged-out landing (static) and logged-in dashboard (live stat)
// ---------------------------------------------------------------------------

interface FeatureCardProps {
  icon: React.ReactNode;
  iconBg?: string;
  title: string;
  body: string;
  statLabel?: string;
  statColor?: string;
  statIcon?: React.ReactNode;
}

function FeatureCard({ icon, iconBg, title, body, statLabel, statColor, statIcon }: FeatureCardProps) {
  return (
    <Paper
      elevation={0}
      sx={{
        p: 2.25,
        borderRadius: 2,
        border: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box
        sx={{
          width: 36,
          height: 36,
          borderRadius: '8px',
          bgcolor: iconBg ?? 'secondary.light',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          mb: 1.25,
          flexShrink: 0,
        }}
      >
        {icon}
      </Box>
      <Typography sx={{ fontSize: 13, fontWeight: 500, color: 'text.primary', mb: 0.5 }}>{title}</Typography>
      <Typography sx={{ fontSize: 12, color: 'text.secondary', lineHeight: 1.5, flex: 1 }}>{body}</Typography>
      {statLabel && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.625, mt: 1.25 }}>
          <Box sx={{ color: statColor ?? 'text.secondary', display: 'flex', alignItems: 'center' }}>{statIcon}</Box>
          <Typography sx={{ fontSize: 13, fontWeight: 600, color: statColor ?? 'text.secondary' }}>
            {statLabel}
          </Typography>
        </Box>
      )}
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Stat card — logged-in dashboard hero
// ---------------------------------------------------------------------------

type StatCardVariant = 'neutral' | 'success' | 'danger';

interface StatCardProps {
  value: number;
  label: string;
  subtitle?: string;
  variant?: StatCardVariant;
  linkTo?: string;
  linkLabel?: string;
}

function StatCard({ value, label, subtitle, variant = 'neutral', linkTo, linkLabel }: StatCardProps) {
  const styles: Record<
    StatCardVariant,
    { bg: string; border: string; valueColor: string; labelColor: string; subColor: string }
  > = {
    neutral: {
      bg: 'background.paper',
      border: 'divider',
      valueColor: 'text.primary',
      labelColor: 'text.secondary',
      subColor: 'text.disabled',
    },
    success: {
      bg: 'secondary.light',
      border: 'secondary.main',
      valueColor: 'secondary.dark',
      labelColor: 'secondary.dark',
      subColor: 'secondary.dark',
    },
    danger: {
      bg: 'error.light',
      border: 'error.main',
      valueColor: 'primary.main',
      labelColor: 'primary.main',
      subColor: 'primary.main',
    },
  };

  const s = styles[variant];

  return (
    <Paper
      elevation={0}
      sx={{
        p: { xs: 1.5, sm: 2 },
        borderRadius: 1.5,
        border: 1,
        borderColor: s.border,
        bgcolor: s.bg,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 100,
      }}
    >
      <Typography
        sx={{
          fontSize: { xs: 28, sm: 32 },
          fontWeight: 700,
          color: s.valueColor,
          lineHeight: 1,
          fontFamily: '"IBM Plex Mono", monospace',
        }}
      >
        {value}
      </Typography>
      <Typography
        sx={{
          fontSize: 11,
          fontWeight: 500,
          color: s.labelColor,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          mt: 0.5,
        }}
      >
        {label}
      </Typography>
      {subtitle && <Typography sx={{ fontSize: 11, color: s.subColor, mt: 0.75 }}>{subtitle}</Typography>}
      {linkTo && linkLabel && (
        <Typography
          component={Link}
          to={linkTo}
          sx={{
            fontSize: 11,
            color: 'primary.main',
            mt: 1,
            fontWeight: 500,
            textDecoration: 'underline',
            textUnderlineOffset: '2px',
            '&:hover': { color: 'primary.dark' },
          }}
        >
          {linkLabel} →
        </Typography>
      )}
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Alert banner — shown when at least one journey exceeds its limit
// ---------------------------------------------------------------------------

interface AlertBannerProps {
  journey: Journey;
  overage: number;
}

function AlertBanner({ journey, overage }: AlertBannerProps) {
  const price = journey.journey?.price ?? 0;
  const departure = journey.journey?.departure;
  const departureFormatted = departure
    ? new Date(departure).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : null;

  return (
    <Box
      sx={{
        bgcolor: 'error.light',
        border: '0.5px solid',
        borderColor: 'error.main',
        borderRadius: 1.5,
        px: 2,
        py: 1.25,
        mb: 2.5,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1.5,
        opacity: 0.95,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
        <Box
          sx={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            bgcolor: 'primary.main',
            flexShrink: 0,
          }}
        />
        <Box sx={{ minWidth: 0 }}>
          <Typography
            sx={{
              fontSize: 12,
              fontWeight: 500,
              color: 'primary.dark',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {journey.from} → {journey.to} is €{overage.toFixed(2)} over your limit
          </Typography>
          <Typography sx={{ fontSize: 11, color: 'primary.main', mt: 0.25 }}>
            Current price €{price.toFixed(2)} · Limit €{journey.limitPrice.toFixed(2)}
            {departureFormatted && ` · Departs ${departureFormatted}`}
          </Typography>
        </Box>
      </Box>
      <Button
        component={Link}
        to={`/journeys#${journey.id}`}
        size="small"
        sx={{
          fontSize: 12,
          fontWeight: 500,
          color: 'primary.main',
          border: '0.5px solid',
          borderColor: 'error.main',
          borderRadius: '6px',
          px: 1.25,
          py: 0.5,
          textTransform: 'none',
          whiteSpace: 'nowrap',
          flexShrink: 0,
          bgcolor: 'transparent',
          '&:hover': { bgcolor: 'rgba(168,35,35,0.08)' },
        }}
      >
        Review ↗
      </Button>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const HomePage: React.FC<Props> = () => {
  const [signupModalOpen, setSignupModalOpen] = useState<boolean>(false);
  const [loginModalOpen, setLoginModalOpen] = useState<boolean>(false);
  const { addAlert } = useAlert();
  const { user } = useContext(AuthContext);
  const [userExistsResult, reexecuteUserExistsQuery] = useQuery({
    query: UserExistsQuery,
    variables: { id: user?.['custom:id'] },
    pause: !user?.['custom:id'],
  });
  const [, createUser] = useMutation(CreateUser);

  const [{ data: userJourneysData, fetching: journeysFetching, error: journeysError }] = useQuery({
    query: UserJourneysQuery,
    variables: { id: user?.['custom:id'] },
    pause: !user?.['custom:id'],
  });

  useEffect(() => {
    if (!user || userExistsResult.fetching) {
      return;
    }
    const userExists = !!userExistsResult.data?.user?.id;
    if (!userExists) {
      createUser({
        id: user['custom:id'],
        email: user['email'],
        familyName: user['family_name'],
        givenName: user['given_name'],
      })
        .then((result) => {
          if (result.error) {
            addAlert(result.error.message, AlertSeverity.Error);
          } else {
            reexecuteUserExistsQuery({ requestPolicy: 'network-only' });
          }
        })
        .catch(() => {
          addAlert('Failed to create account. Please try again.', AlertSeverity.Error);
        });
    }
  }, [addAlert, createUser, reexecuteUserExistsQuery, user, userExistsResult]);

  if (!user) {
    return (
      <LoggedOutHero onSignup={() => setSignupModalOpen(true)} onLogin={() => setLoginModalOpen(true)}>
        <SignupModal open={signupModalOpen} onClose={() => setSignupModalOpen(false)} />
        <LoginModal open={loginModalOpen} onClose={() => setLoginModalOpen(false)} />
      </LoggedOutHero>
    );
  }

  if (userExistsResult.fetching) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 100 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (journeysFetching) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 100 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (journeysError) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 100 }}>
        <Typography sx={{ fontSize: 13, color: 'error.main' }}>
          Failed to load journey data. Please try again later.
        </Typography>
      </Box>
    );
  }

  const journeyMonitors: Journey[] = userJourneysData?.user?.journeyMonitors ?? [];

  return <LoggedInDashboard userName={user.given_name ?? ''} journeyMonitors={journeyMonitors} />;
};

// ---------------------------------------------------------------------------
// Logged-out hero
// ---------------------------------------------------------------------------

interface LoggedOutHeroProps {
  onSignup: () => void;
  onLogin: () => void;
  children: React.ReactNode;
}

function LoggedOutHero({ onSignup, onLogin, children }: LoggedOutHeroProps) {
  return (
    <>
      <Chip
        icon={<TrainIcon sx={{ fontSize: '14px !important' }} />}
        label="Deutsche Bahn price alerts"
        size="small"
        sx={{
          bgcolor: 'secondary.light',
          color: 'secondary.dark',
          fontWeight: 700,
          fontSize: 11,
          border: 1,
          borderColor: 'secondary.main',
          letterSpacing: '0.04em',
          mb: 2,
          display: { xs: 'none', sm: 'inline-flex' },
        }}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: { sm: 5 }, mb: 4.5 }}>
        <Box
          component="img"
          src={process.env.PUBLIC_URL + '/logo-hero.webp'}
          alt="Train Price Monitor Logo"
          width={220}
          height={220}
          sx={{ display: { xs: 'none', sm: 'block' }, flexShrink: 0 }}
        />
        <Box>
          <Typography
            variant="h1"
            sx={{
              fontSize: { xs: 24, sm: 30 },
              mb: 1.25,
            }}
          >
            Stop overpaying for
            <br />
            <Box component="span" sx={{ color: 'primary.main' }}>
              train tickets.
            </Box>
          </Typography>
          <Typography
            sx={{
              fontSize: 14,
              color: 'text.secondary',
              lineHeight: 1.65,
              maxWidth: 460,
              mb: 3,
            }}
          >
            Watch a journey and set your price limit. Train Price Monitor checks fares hourly and alerts you the moment
            the price rises above your threshold — so you can act before it&apos;s too late.
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexWrap: 'wrap' }}>
            <Button variant="contained" onClick={onSignup} sx={{ textTransform: 'none', fontWeight: 600 }}>
              Create free account →
            </Button>
            <Button
              variant="outlined"
              onClick={onLogin}
              sx={{
                textTransform: 'none',
                fontWeight: 500,
                color: 'text.primary',
                borderColor: 'divider',
                '&:hover': { borderColor: 'primary.main', color: 'primary.main' },
              }}
            >
              Log in
            </Button>
          </Box>
        </Box>
      </Box>
      <Grid container spacing={1.75}>
        <Grid size={{ xs: 12, sm: 4 }}>
          <FeatureCard
            icon={<Visibility sx={{ fontSize: 16 }} />}
            title="Hourly price checks"
            body="We poll Deutsche Bahn's systems every hour for every journey you're watching. You'll never miss a price movement."
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 4 }}>
          <FeatureCard
            icon={<NotificationsActive sx={{ fontSize: 16 }} />}
            title="Instant alerts"
            body="Set your own price limit. Get notified in-app and by email the moment a ticket rises above your threshold."
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 4 }}>
          <FeatureCard
            icon={<ConfirmationNumber sx={{ fontSize: 16 }} />}
            title="Multiple journeys"
            body="Watch as many connections as you need. Each one gets its own limit and independent monitoring."
          />
        </Grid>
      </Grid>
      {children}
    </>
  );
}

// ---------------------------------------------------------------------------
// Logged-in dashboard
// ---------------------------------------------------------------------------

interface LoggedInDashboardProps {
  userName: string;
  journeyMonitors: Journey[];
}

function LoggedInDashboard({ userName, journeyMonitors }: LoggedInDashboardProps) {
  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  };

  const belowLimit = journeyMonitors.filter((j) => j.journey?.price != null && j.journey.price <= j.limitPrice);
  const overLimit = journeyMonitors.filter((j) => j.journey?.price != null && j.journey.price > j.limitPrice);

  const totalSavings = belowLimit.reduce((acc, j) => acc + (j.limitPrice - (j.journey?.price ?? 0)), 0);

  const alertJourney = overLimit[0] ?? null;
  const overage = alertJourney ? alertJourney.journey!.price! - alertJourney.limitPrice : 0;

  return (
    <>
      {/* ── Hero ── */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
          gap: { xs: 3, md: 4 },
          alignItems: 'center',
          pb: 3,
          mb: 0,
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        {/* Left column */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          <Chip
            icon={<TrainIcon sx={{ fontSize: '13px !important' }} />}
            label="Deutsche Bahn price alerts"
            size="small"
            sx={{
              bgcolor: 'background.paper',
              color: 'text.secondary',
              fontWeight: 500,
              fontSize: 12,
              border: '0.5px solid',
              borderColor: 'divider',
              alignSelf: 'flex-start',
              mb: 1.5,
            }}
          />
          <Typography sx={{ fontSize: 18, fontWeight: 500, color: 'text.primary', mb: 0.375 }}>
            {getGreeting()}, {userName} 👋
          </Typography>
          <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: 2.25 }}>
            Here&apos;s an overview of your monitored journeys.
          </Typography>
          <Typography
            variant="h1"
            sx={{
              fontSize: { xs: 24, sm: 27 },
              lineHeight: 1.2,
              mb: 0,
            }}
          >
            Stop overpaying for
            <br />
            <Box component="span" sx={{ color: 'primary.main' }}>
              train tickets.
            </Box>
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2.25, flexWrap: 'wrap' }}>
            <Button
              variant="contained"
              component={Link}
              to="/search"
              startIcon={
                <Box component="span" sx={{ fontSize: 15, lineHeight: 1 }}>
                  +
                </Box>
              }
              sx={{ textTransform: 'none', fontWeight: 500, fontSize: 13 }}
            >
              Add journey
            </Button>
            <Button
              variant="outlined"
              component={Link}
              to="/journeys"
              endIcon={<ArrowForward sx={{ fontSize: '14px !important' }} />}
              sx={{
                textTransform: 'none',
                fontWeight: 500,
                fontSize: 13,
                color: 'text.primary',
                borderColor: 'divider',
                '&:hover': { borderColor: 'primary.main', color: 'primary.main' },
              }}
            >
              My Journeys
            </Button>
          </Box>
        </Box>

        {/* Right column — stat cards */}
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 1.25,
          }}
        >
          <StatCard value={journeyMonitors.length} label="Monitored" subtitle="Checked every hour" variant="neutral" />
          <StatCard
            value={belowLimit.length}
            label="Below limit"
            subtitle={belowLimit.length > 0 ? `~€${totalSavings.toFixed(0)} saved vs limits` : 'All within budget'}
            variant="success"
          />
          <StatCard
            value={overLimit.length}
            label="Over limit"
            variant="danger"
            linkTo="/journeys"
            linkLabel={overLimit.length > 0 ? 'Review now' : undefined}
          />
        </Box>
      </Box>

      {/* ── Alert banner ── */}
      {alertJourney && (
        <Box sx={{ mt: 2.5 }}>
          <AlertBanner journey={alertJourney} overage={overage} />
        </Box>
      )}

      {/* ── Feature tiles ── */}
      <Box sx={{ mt: alertJourney ? 0 : 2.5 }}>
        <Grid container spacing={1.25}>
          <Grid size={{ xs: 12, sm: 4 }}>
            <FeatureCard
              icon={<Visibility sx={{ fontSize: 18, color: '#2D5A18' }} />}
              iconBg="#BCD9A2"
              title="Hourly price checks"
              body="We poll Deutsche Bahn every hour for every journey you're watching."
              statLabel={`${journeyMonitors.length} active`}
              statColor="#6D9E51"
              statIcon={<CheckCircleOutline sx={{ fontSize: 15 }} />}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 4 }}>
            <FeatureCard
              icon={<NotificationsActive sx={{ fontSize: 18, color: '#A82323' }} />}
              iconBg="#F9E0E0"
              title="Instant alerts"
              body="Get notified in-app and by email the moment a ticket crosses your threshold."
              statLabel={overLimit.length > 0 ? `${overLimit.length} alert active` : 'No active alerts'}
              statColor={overLimit.length > 0 ? '#A82323' : '#6D9E51'}
              statIcon={
                overLimit.length > 0 ? (
                  <ErrorOutline sx={{ fontSize: 15 }} />
                ) : (
                  <CheckCircleOutline sx={{ fontSize: 15 }} />
                )
              }
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 4 }}>
            <FeatureCard
              icon={<ConfirmationNumber sx={{ fontSize: 18, color: '#7A7200' }} />}
              iconBg="#FEFFD3"
              title="Multiple journeys"
              body="Watch as many connections as you need. Each with its own limit and independent monitoring."
              statLabel={`${journeyMonitors.length} journeys`}
              statColor="#7A7200"
              statIcon={<AllInclusive sx={{ fontSize: 15 }} />}
            />
          </Grid>
        </Grid>
      </Box>
    </>
  );
}

export default HomePage;
