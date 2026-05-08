import React, { useContext, useEffect, useState } from 'react';
import { Box, Button, ListItemIcon, ListItemText, Menu, MenuItem, Stack, Typography } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from 'urql';

import { UserJourneysQuery } from '../api/user';
import { AuthContext } from '../providers/AuthProvider';
import { DeleteJourneyMonitor } from '../api/journey';
import { AlertSeverity } from '../providers/AlertProvider';
import useAlert from '../hooks/useAlert';
import JourneyTicket, { Journey } from '../components/JourneyTicket';

const JourneysPage: React.FC = () => {
  const { user } = useContext(AuthContext);
  const { addAlert } = useAlert();
  const [{ data: userJourneysResult, fetching: userJourneysFetching }, reexecuteUserJourneysQuery] = useQuery({
    query: UserJourneysQuery,
    variables: { id: user?.['custom:id'] },
    pause: !user?.['custom:id'],
  });
  const [, deleteJourneyMonitor] = useMutation(DeleteJourneyMonitor);

  const [loadingJourneyIds, setLoadingJourneyIds] = useState<Set<string>>(new Set());
  const [deletedJourneyIds, setDeletedJourneyIds] = useState<Set<string>>(new Set());
  const [menuAnchor, setMenuAnchor] = useState<{ el: HTMLElement; id: string } | null>(null);

  const journeyMonitors =
    userJourneysResult?.user?.journeyMonitors?.filter((j: Journey) => !deletedJourneyIds.has(j.id)) ?? [];

  const belowLimitCount = journeyMonitors.filter(
    (j: Journey) => j.journey?.price != null && j.journey.price <= j.limitPrice
  ).length;

  useEffect(() => {
    reexecuteUserJourneysQuery({ requestPolicy: 'network-only' });
  }, [reexecuteUserJourneysQuery]);

  function handleJourneyMonitorDelete(id: string): void {
    setLoadingJourneyIds((prev) => new Set([...prev, id]));
    deleteJourneyMonitor({ userId: user?.['custom:id'], journeyId: id }).then((result) => {
      if (result.error) {
        addAlert(result.error.message, AlertSeverity.Error);
        setLoadingJourneyIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      } else {
        setDeletedJourneyIds((prev) => new Set([...prev, id]));
        setLoadingJourneyIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        reexecuteUserJourneysQuery({ requestPolicy: 'network-only' });
      }
    });
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
          <Typography sx={{ fontSize: 20, fontWeight: 700, color: 'text.primary', letterSpacing: '-0.02em', mb: 0.25 }}>
            Journey Watchlist
          </Typography>
          {!userJourneysFetching && journeyMonitors.length > 0 && (
            <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
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
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>Loading journeys...</Typography>
      ) : journeyMonitors.length > 0 ? (
        <Stack spacing={1.5}>
          {journeyMonitors.map((monitor: Journey) => (
            <JourneyTicket
              key={monitor.id}
              monitor={monitor}
              onOpenMenu={(el, id) => setMenuAnchor({ el, id })}
              loadingIds={loadingJourneyIds}
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
              handleJourneyMonitorDelete(menuAnchor.id);
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
    </Box>
  );
};

export default JourneysPage;
