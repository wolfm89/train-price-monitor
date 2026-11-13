import React, { useContext, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { Link, useLocation } from 'react-router-dom';
import { useMutation, useQuery } from 'urql';

import { UserJourneysQuery } from '../api/user';
import { AuthContext } from '../providers/AuthProvider';
import { DeleteJourneyMonitor } from '../api/journey';
import { AlertSeverity } from '../providers/AlertProvider';
import useAlert from '../hooks/useAlert';
import usePrefersReducedMotion from '../hooks/usePrefersReducedMotion';
import JourneyTicket, { Journey } from '../components/JourneyTicket';
import LoadingStatus from '../components/LoadingStatus';

const JourneysPage: React.FC = () => {
  const { user } = useContext(AuthContext);
  const { addAlert } = useAlert();
  const location = useLocation();
  const reducedMotion = usePrefersReducedMotion();
  const [
    { data: userJourneysResult, fetching: userJourneysFetching, error: userJourneysError },
    reexecuteUserJourneysQuery,
  ] = useQuery({
    query: UserJourneysQuery,
    variables: { id: user?.['custom:id'] },
    pause: !user?.['custom:id'],
  });
  const [, deleteJourneyMonitor] = useMutation(DeleteJourneyMonitor);

  const [loadingJourneyIds, setLoadingJourneyIds] = useState<Set<string>>(new Set());
  const [deletedJourneyIds, setDeletedJourneyIds] = useState<Set<string>>(new Set());
  const [menuAnchor, setMenuAnchor] = useState<{ el: HTMLElement; id: string } | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [highlightedJourneyId, setHighlightedJourneyId] = useState<string | null>(null);

  const journeyMonitors =
    userJourneysResult?.user?.journeyMonitors?.filter((j: Journey) => !deletedJourneyIds.has(j.id)) ?? [];
  const pendingJourney = journeyMonitors.find((journey: Journey) => journey.id === pendingDeleteId) ?? null;
  const deletingPendingJourney = pendingDeleteId !== null && loadingJourneyIds.has(pendingDeleteId);

  const belowLimitCount = journeyMonitors.filter(
    (j: Journey) => j.journey?.price != null && j.journey.price <= j.limitPrice
  ).length;

  useEffect(() => {
    reexecuteUserJourneysQuery({ requestPolicy: 'network-only' });
  }, [reexecuteUserJourneysQuery]);

  // Notification, email and "Review ↗" links point at /journeys#<journeyId>.
  // The ticket only exists after the watchlist query resolves, so wait for it,
  // then scroll and briefly outline the matching ticket. An unknown hash is a
  // no-op.
  useEffect(() => {
    // A new navigation always drops the previous outline, including an invalid
    // hash that no longer resolves to a ticket.
    setHighlightedJourneyId(null);

    if (!location.hash || userJourneysFetching) {
      return;
    }

    let targetId: string;
    try {
      targetId = decodeURIComponent(location.hash.slice(1));
    } catch {
      return;
    }
    if (!targetId) {
      return;
    }

    const target = document.getElementById(targetId);
    if (!target) {
      return;
    }

    target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
    target.focus({ preventScroll: true });
    setHighlightedJourneyId(targetId);
    const timeout = window.setTimeout(() => setHighlightedJourneyId(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [location.hash, location.key, reducedMotion, userJourneysFetching, journeyMonitors.length]);

  async function handleJourneyMonitorDelete(id: string): Promise<boolean> {
    setLoadingJourneyIds((prev) => new Set([...prev, id]));
    try {
      const result = await deleteJourneyMonitor({ userId: user?.['custom:id'], journeyId: id });
      if (result.error) {
        addAlert(result.error.message, AlertSeverity.Error);
        return false;
      }

      setDeletedJourneyIds((prev) => new Set([...prev, id]));
      reexecuteUserJourneysQuery({ requestPolicy: 'network-only' });
      addAlert('Journey removed from your watchlist.', AlertSeverity.Success);
      return true;
    } catch {
      addAlert('Failed to remove the journey. Please try again.', AlertSeverity.Error);
      return false;
    } finally {
      setLoadingJourneyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDeleteId) return;
    const removed = await handleJourneyMonitorDelete(pendingDeleteId);
    if (removed) setPendingDeleteId(null);
  }

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 1.5,
          mb: 2.75,
        }}
      >
        <Box>
          <Typography component="h1" variant="h5" sx={{ mb: 0.25 }}>
            Journey Watchlist
          </Typography>
          {!userJourneysFetching && !userJourneysError && journeyMonitors.length > 0 && (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Monitoring {journeyMonitors.length} journey{journeyMonitors.length !== 1 ? 's' : ''} · {belowLimitCount}{' '}
              below limit
            </Typography>
          )}
        </Box>
        <Button variant="contained" component={Link} to="/search" sx={{ textTransform: 'none', fontWeight: 600 }}>
          + Add journey
        </Button>
      </Box>

      {userJourneysFetching ? (
        <LoadingStatus label="Loading journeys…" />
      ) : userJourneysError ? (
        <Alert
          severity="error"
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => reexecuteUserJourneysQuery({ requestPolicy: 'network-only' })}
            >
              Try again
            </Button>
          }
        >
          Could not load your journeys. Please try again.
        </Alert>
      ) : journeyMonitors.length > 0 ? (
        <Stack spacing={1.5}>
          {journeyMonitors.map((monitor: Journey) => (
            <JourneyTicket
              key={monitor.id}
              monitor={monitor}
              onOpenMenu={(el, id) => setMenuAnchor({ el, id })}
              loadingIds={loadingJourneyIds}
              highlighted={monitor.id === highlightedJourneyId}
            />
          ))}
        </Stack>
      ) : (
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>No journeys found.</Typography>
      )}

      <Menu
        anchorEl={menuAnchor?.el}
        open={Boolean(menuAnchor)}
        onClose={() => setMenuAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { minWidth: 200 } } }}
      >
        <MenuItem
          onClick={() => {
            if (menuAnchor) {
              setPendingDeleteId(menuAnchor.id);
              setMenuAnchor(null);
            }
          }}
          disabled={loadingJourneyIds.has(menuAnchor?.id ?? '')}
          sx={{ color: 'error.main' }}
        >
          <ListItemIcon>
            <DeleteIcon sx={{ fontSize: 18, color: 'error.main' }} />
          </ListItemIcon>
          <ListItemText>Remove from watchlist</ListItemText>
        </MenuItem>
      </Menu>

      <Dialog
        open={pendingDeleteId !== null}
        onClose={() => {
          if (!deletingPendingJourney) setPendingDeleteId(null);
        }}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Remove journey?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {pendingJourney
              ? `${pendingJourney.from ?? 'Unknown'} → ${pendingJourney.to ?? 'Unknown'} will be removed from your watchlist.`
              : 'This journey will be removed from your watchlist.'}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDeleteId(null)} disabled={deletingPendingJourney}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={confirmDelete}
            disabled={deletingPendingJourney}
            startIcon={deletingPendingJourney ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />}
          >
            Remove
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default JourneysPage;
