import React, { useState } from 'react';
import { Container, Grid, Typography, Accordion, AccordionSummary, AccordionDetails, List, ListItem } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

interface Journey {
  id: number;
  departure: string;
  destination: string;
  date: string;
  time: string;
  meansOfTransport: string[];
  currentPrice: number;
}

const JourneysPage: React.FC = () => {
  // Dummy journey data
  const journeys: Journey[] = [
    {
      id: 1,
      departure: 'Station A',
      destination: 'Station B',
      date: '2023-05-20',
      time: '09:30',
      meansOfTransport: ['EC', 'RJ'],
      currentPrice: 42.50
    },
    {
      id: 2,
      departure: 'Station C',
      destination: 'Station D',
      date: '2023-05-22',
      time: '14:45',
      meansOfTransport: ['R'],
      currentPrice: 28.90
    }
  ];

  const [expandedJourneyId, setExpandedJourneyId] = useState<number | null>(null);

  const toggleJourneyDetails = (journeyId: number) => {
    if (expandedJourneyId === journeyId) {
      setExpandedJourneyId(null);
    } else {
      setExpandedJourneyId(journeyId);
    }
  };

  return (
    <Container maxWidth="md" sx={{ my: 4 }}>
      <Grid container spacing={2}>
        <Grid item xs={12}>
          <Typography variant="h6">My Journeys</Typography>
        </Grid>
        <Grid item xs={12}>
          {journeys.length > 0 ? (
            <List>
              {journeys.map((journey) => (
                <ListItem key={journey.id}>
                  <Accordion
                    sx={{ width: "100%" }}
                    expanded={expandedJourneyId === journey.id}
                    onChange={() => toggleJourneyDetails(journey.id)}
                  >
                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                      <Grid container justifyContent="space-between" alignItems="center">
                        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
                          {`${journey.departure} to ${journey.destination}`}
                        </Typography>
                        <Typography variant="body2">
                          {`Price: €${journey.currentPrice.toFixed(2)}`}
                        </Typography>
                      </Grid>
                    </AccordionSummary>
                    <AccordionDetails>
                      <Grid container spacing={2}>
                        <Grid item xs={12}>
                          <Typography variant="body2">{`Date: ${journey.date}`}</Typography>
                        </Grid>
                        <Grid item xs={12}>
                          <Typography variant="body2">{`Time: ${journey.time}`}</Typography>
                        </Grid>
                        <Grid item xs={12}>
                          <Typography variant="body2">{`Means of Transport: ${journey.meansOfTransport.join(
                            ', '
                          )}`}</Typography>
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
    </Container>
  );
};

export default JourneysPage;
