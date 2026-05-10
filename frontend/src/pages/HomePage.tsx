import React, { useContext, useEffect, useState } from 'react';
import SignupModal from '../components/SignupModal';
import LoginModal from '../components/LoginModal';
import { Button, Typography, Box, CircularProgress, Chip, Paper, Grid } from '@mui/material';
import { Train as TrainIcon, Visibility, NotificationsActive, ConfirmationNumber } from '@mui/icons-material';
import { Link } from 'react-router-dom';
import { AuthContext } from '../providers/AuthProvider';
import { AlertSeverity } from '../providers/AlertProvider';
import useAlert from '../hooks/useAlert';
import { UserExistsQuery, CreateUser, UserJourneysQuery } from '../api/user';
import { useMutation, useQuery } from 'urql';
import JourneyTicket, { Journey } from '../components/JourneyTicket';

interface Props {}

// ---------------------------------------------------------------------------
// Feature card for logged-out landing
// ---------------------------------------------------------------------------

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  body: string;
}

function FeatureCard({ icon, title, body }: FeatureCardProps) {
  return (
    <Paper
      elevation={0}
      sx={{
        p: 2.25,
        borderRadius: 2,
        border: 1,
        borderColor: 'divider',
        bgcolor: 'background.default',
      }}
    >
      <Box
        sx={{
          width: 34,
          height: 34,
          borderRadius: '7px',
          bgcolor: 'secondary.light',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          mb: 1.25,
          color: 'secondary.dark',
        }}
      >
        {icon}
      </Box>
      <Typography sx={{ fontSize: 12, fontWeight: 700, color: 'text.primary', mb: 0.5 }}>{title}</Typography>
      <Typography sx={{ fontSize: 11, color: 'text.secondary', lineHeight: 1.55 }}>{body}</Typography>
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Stats banner for logged-in dashboard
// ---------------------------------------------------------------------------

interface StatsBannerProps {
  monitored: number;
  belowLimit: number;
}

function StatsBanner({ monitored, belowLimit }: StatsBannerProps) {
  return (
    <Box
      sx={{
        bgcolor: 'secondary.light',
        border: 1,
        borderColor: 'secondary.main',
        borderRadius: 3,
        px: 2.75,
        py: 2.25,
        mb: 3,
        display: 'flex',
        alignItems: 'center',
        gap: 2.5,
        flexWrap: 'wrap',
      }}
    >
      <StatItem value={monitored} label="Monitored" />
      <Box sx={{ width: '1px', height: 32, bgcolor: 'secondary.main' }} />
      <StatItem value={belowLimit} label="Below limit" />
    </Box>
  );
}

function StatItem({ value, label }: { value: number; label: string }) {
  return (
    <Box>
      <Typography
        sx={{
          fontSize: 20,
          fontWeight: 700,
          color: 'primary.main',
          fontFamily: '"IBM Plex Mono", monospace',
        }}
      >
        {value}
      </Typography>
      <Typography
        sx={{
          fontSize: 10,
          color: 'secondary.dark',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {label}
      </Typography>
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
  const recentJourneys = journeyMonitors.slice(0, 2);
  const belowLimitCount = journeyMonitors.filter(
    (j) => j.journey?.price != null && j.journey.price <= j.limitPrice
  ).length;

  return (
    <LoggedInDashboard
      userName={user.given_name ?? ''}
      journeyMonitors={journeyMonitors}
      recentJourneys={recentJourneys}
      belowLimitCount={belowLimitCount}
    />
  );
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
          src={process.env.PUBLIC_URL + '/logo256.png'}
          alt="Train Price Monitor Logo"
          sx={{ display: { xs: 'none', sm: 'block' }, width: 220, height: 220, flexShrink: 0 }}
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
  recentJourneys: Journey[];
  belowLimitCount: number;
}

function LoggedInDashboard({ userName, journeyMonitors, recentJourneys, belowLimitCount }: LoggedInDashboardProps) {
  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  };

  return (
    <>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 1.5,
          mb: 3,
        }}
      >
        <Box>
          <Typography variant="h5">
            {getGreeting()}, {userName} 👋
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Here&apos;s an overview of your monitored journeys.
          </Typography>
        </Box>
        <Button variant="contained" component={Link} to="/search" sx={{ textTransform: 'none', fontWeight: 600 }}>
          + Add journey
        </Button>
      </Box>

      <StatsBanner monitored={journeyMonitors.length} belowLimit={belowLimitCount} />

      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="overline">Recent journeys</Typography>
        <Button
          component={Link}
          to="/journeys"
          sx={{
            fontSize: 12,
            fontWeight: 500,
            textTransform: 'none',
            color: 'text.secondary',
            '&:hover': { color: 'text.primary' },
          }}
        >
          View all →
        </Button>
      </Box>

      {recentJourneys.length > 0 ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {recentJourneys.map((monitor) => (
            <JourneyTicket
              key={monitor.id}
              monitor={monitor}
              onOpenMenu={() => {}}
              loadingIds={new Set()}
              showMenu={false}
            />
          ))}
        </Box>
      ) : (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          No journeys yet. Search for a connection to get started.
        </Typography>
      )}
    </>
  );
}

export default HomePage;
