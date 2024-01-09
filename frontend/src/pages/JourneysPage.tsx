import React, { useContext, useEffect, useState } from 'react';
import {
  Grid,
  Typography,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  List,
  ListItem,
  IconButton,
  CircularProgress,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useMutation, useQuery } from 'urql';
import { UserJourneysQuery } from '../api/user';
import { AuthContext } from '../providers/AuthProvider';
import { useLocation } from 'react-router-dom';
import DeleteIcon from '@mui/icons-material/Delete';
import { DeleteJourneyMonitor } from '../api/journey';
import { AlertSeverity } from '../providers/AlertProvider';
import useAlert from '../hooks/useAlert';

interface Journey {
  id: string;
  limitPrice: number;
  journey: {
    from: string;
    to: string;
    refreshToken: string;
    departure: string;
    arrival: string;
    means: string[];
    price: number;
  };
}

const JourneysPage: React.FC = () => {
  const { user } = useContext(AuthContext);
  const { hash } = useLocation();
  const { addAlert } = useAlert();
  const [{ data: userJourneysResult, fetching: userJourneysFetching }, reexecuteUserJourneysQuery] = useQuery({
    query: UserJourneysQuery,
    variables: { id: user?.['custom:id'] },
    pause: !user,
  });
  const [{ fetching: deleteJourneyMonitorFetching }, deleteJourneyMonitor] = useMutation(DeleteJourneyMonitor);

  const [expandedJourneyIds, setExpandedJourneyIds] = useState<string[]>([]);
  const [loadingJourneyId, setLoadingJourneyId] = useState<string | null>(null);

  const toggleJourneyDetails = (journeyId: string) => {
    setExpandedJourneyIds((prevIds) => {
      if (prevIds.includes(journeyId)) {
        // If the ID is already in the array, remove it
        return prevIds.filter((id) => id !== journeyId);
      } else {
        // If the ID is not in the array, add it
        return [...prevIds, journeyId];
      }
    });
  };

  useEffect(() => {
    if (hash) {
      // Get the journeyId parameter from the URL
      const journeyId = hash.split('#').pop()!;
      // Update the state to open the accordion
      setExpandedJourneyIds([journeyId]);
    }
  }, [hash]);

  useEffect(() => {
    reexecuteUserJourneysQuery({ requestPolicy: 'network-only' });
  }, [reexecuteUserJourneysQuery]);

  const formatDateTime = (dateTime: string) => {
    const date = new Date(dateTime);
    const formattedDate = date.toLocaleDateString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
    const formattedTime = date.toLocaleTimeString('de-DE', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${formattedDate} ${formattedTime}`;
  };

  function handleJourneyMonitorDelete(id: string): void {
    setLoadingJourneyId(id);
    deleteJourneyMonitor({ userId: user?.['custom:id'], journeyId: id }).then((result) => {
      if (result.error) {
        addAlert(result.error.message, AlertSeverity.Error);
      }
      setLoadingJourneyId(null);
    });
  }

  return (
    <Grid container spacing={2}>
      <Grid item xs={12}>
        <Typography variant="h6">Journey Watchlist</Typography>
      </Grid>
      <Grid item xs={12}>
        {userJourneysFetching ? (
          <Typography variant="body1">Loading journeys...</Typography>
        ) : userJourneysResult && userJourneysResult.user.journeyMonitors.length > 0 ? (
          <List>
            {userJourneysResult.user.journeyMonitors.map(({ id, limitPrice, journey }: Journey) => (
              <ListItem key={id} alignItems="flex-start">
                <Accordion
                  sx={{ width: '100%' }}
                  expanded={expandedJourneyIds.includes(id)}
                  onChange={() => toggleJourneyDetails(id)}
                >
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Grid container justifyContent="space-between" alignItems="center" spacing={2}>
                      <Grid item sm={6} xs={12}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
                          {`${journey.from} to ${journey.to}`}
                        </Typography>
                      </Grid>
                      <Grid item sm={3} xs={6} sx={{ textAlign: 'right' }}>
                        <Typography variant="body2">{`Limit Price: €${limitPrice.toFixed(2)}`}</Typography>
                      </Grid>
                      <Grid item sm={3} xs={6} sx={{ textAlign: 'right' }}>
                        <Typography
                          variant="body2"
                          sx={{
                            color: journey.price !== null ? (journey.price > limitPrice ? 'red' : 'green') : 'inherit',
                          }}
                        >
                          Current Price: {journey.price !== null ? `€${journey.price.toFixed(2)}` : 'n/a'}
                        </Typography>
                      </Grid>
                    </Grid>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Grid container spacing={2}>
                      <Grid item xs={12}>
                        <Typography variant="body2">{`Departure: ${formatDateTime(journey.departure)}`}</Typography>
                      </Grid>
                      <Grid item xs={12}>
                        <Typography variant="body2">{`Arrival: ${formatDateTime(journey.arrival)}`}</Typography>
                      </Grid>
                      <Grid item xs={12}>
                        <Typography variant="body2">{`Means of Transport: ${journey.means
                          .map((mean: string) => (mean === 'walk' ? '\u{1F6B6}' : mean))
                          .join(' \u{2192} ')}`}</Typography>
                      </Grid>
                    </Grid>
                  </AccordionDetails>
                </Accordion>
                <IconButton
                  aria-label="delete"
                  disabled={deleteJourneyMonitorFetching || loadingJourneyId === id}
                  onClick={() => handleJourneyMonitorDelete(id)}
                >
                  {loadingJourneyId === id ? <CircularProgress size={20} /> : <DeleteIcon />}
                </IconButton>
              </ListItem>
            ))}
          </List>
        ) : (
          <Typography variant="body1">No journeys found.</Typography>
        )}
      </Grid>
    </Grid>
  );
};

export default JourneysPage;
