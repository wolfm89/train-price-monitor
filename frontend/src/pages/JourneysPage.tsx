import React, { useContext, useEffect, useState } from 'react';
import { Grid, Typography, Accordion, AccordionSummary, AccordionDetails, List, ListItem } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useQuery } from 'urql';
import { UserJourneysQuery } from '../api/user';
import { AuthContext } from '../providers/AuthProvider';

interface Journey {
  id: number;
  from: string;
  to: string;
  departure: string;
  arrival: string;
  means: string[];
  price: number;
  limitPrice: number;
  refreshToken: string;
}

const JourneysPage: React.FC = () => {
  const { user } = useContext(AuthContext);
  const [{ data: userJourneysResult, fetching }, reexecuteUserJourneysQuery] = useQuery({
    query: UserJourneysQuery,
    variables: { id: user?.['custom:id'], journeysLimit: 5 },
    pause: !user,
  });

  const [expandedJourneyIds, setExpandedJourneyIds] = useState<number[]>([]);

  const toggleJourneyDetails = (journeyId: number) => {
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

  return (
    <Grid container spacing={2}>
      <Grid item xs={12}>
        <Typography variant="h6">Journey Watchlist</Typography>
      </Grid>
      <Grid item xs={12}>
        {fetching ? (
          <Typography variant="body1">Loading journeys...</Typography>
        ) : userJourneysResult && userJourneysResult.user.journeys.length > 0 ? (
          <List>
            {userJourneysResult.user.journeys.map((journey: Journey) => (
              <ListItem key={journey.id}>
                <Accordion
                  sx={{ width: '100%' }}
                  expanded={expandedJourneyIds.includes(journey.id)}
                  onChange={() => toggleJourneyDetails(journey.id)}
                >
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Grid container justifyContent="space-between" alignItems="center">
                      <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
                        {`${journey.from} to ${journey.to}`}
                      </Typography>
                      <Typography variant="body2" sx={{ color: journey.price > journey.limitPrice ? 'red' : 'green' }}>
                        {`Current Price: €${journey.price.toFixed(2)}`}
                      </Typography>
                      <Typography variant="body2">{`Limit Price: €${journey.limitPrice.toFixed(2)}`}</Typography>
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
