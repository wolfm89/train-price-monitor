import React, { useContext, useEffect, useState } from 'react';
import { Grid, ListItemIcon, ListItemText, Menu, MenuItem, Stack, Typography } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
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
      }
    });
  }

  return (
    <Grid container spacing={2}>
      <Grid size={12}>
        <Typography variant="h6">Journey Watchlist</Typography>
      </Grid>
      <Grid size={12}>
        {userJourneysFetching ? (
          <Typography variant="body1">Loading journeys...</Typography>
        ) : journeyMonitors.length > 0 ? (
          <Stack spacing={2}>
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
          <Typography variant="body1">No journeys found.</Typography>
        )}

        {/* Shared overflow menu — one instance, anchored to whichever ticket's button was tapped */}
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
      </Grid>
    </Grid>
  );
};

export default JourneysPage;
