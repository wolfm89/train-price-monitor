import React, { useEffect, useState } from 'react';
import { Button, TextField, Grid, Typography } from '@mui/material';
import { useQuery } from 'urql';
import { JourneySearchQuery } from '../api/journey';

interface Props {
  setSearchData: (searchData: any) => void;
  setSearchResult: (searchResult: any) => void;
  setLoading: (loading: boolean) => void;
  setSearchClicked: (searchClicked: boolean) => void;
}

const SearchMask: React.FC<Props> = ({ setSearchData, setSearchResult, setLoading, setSearchClicked }) => {
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [departureDay, setDepartureDay] = useState<string>('');
  const [departureTime, setDepartureTime] = useState<string>('');
  const [formValid, setFormValid] = useState<boolean>(false);
  const [{ data, fetching }, reexecuteJourneySearchQuery] = useQuery({
    query: JourneySearchQuery,
    variables: {
      from: from.trim(),
      to: to.trim(),
      departure: `${formValid ? createISODateString(departureDay.trim(), departureTime.trim()) : ''}`,
    },
    pause: true,
  });

  useEffect(() => {
    setSearchResult(data?.journeys);
    setLoading(fetching);
  }, [data, fetching, setLoading, setSearchResult]);

  function createISODateString(day: string, time: string): string {
    const [year, month, date] = day.split('-').map(Number);
    const [hours, minutes] = time.split(':').map(Number);

    const dateObject = new Date(year, month - 1, date, hours, minutes);

    return dateObject.toISOString();
  }

  const handleSearchClick = () => {
    setSearchClicked(true);
    setLoading(true);
    setSearchData({
      departure: from.trim(),
      destination: to.trim(),
      date: departureDay,
      time: departureTime,
    });
    reexecuteJourneySearchQuery({ requestPolicy: 'network-only' });
  };

  // Update form validity based on input fields
  React.useEffect(() => {
    setFormValid(from.trim() !== '' && to.trim() !== '' && departureDay.trim() !== '' && departureTime.trim() !== '');
  }, [from, to, departureDay, departureTime]);

  return (
    <Grid container spacing={2}>
      <Grid item xs={3} sm={1} container justifyContent="flex-end" alignItems="center">
        <Typography>From:</Typography>
      </Grid>
      <Grid item xs={9} sm={5}>
        <TextField id="departure" value={from} onChange={(e) => setFrom(e.target.value)} fullWidth />
      </Grid>
      <Grid item xs={3} sm={1} container justifyContent="flex-end" alignItems="center">
        <Typography>To:</Typography>
      </Grid>
      <Grid item xs={9} sm={5}>
        <TextField id="destination" value={to} onChange={(e) => setTo(e.target.value)} fullWidth />
      </Grid>
      <Grid item xs={3} sm={1} container justifyContent="flex-end" alignItems="center">
        <Typography>Departure:</Typography>
      </Grid>
      <Grid item xs={5} sm={3}>
        <TextField
          id="date"
          type="date"
          value={departureDay}
          onChange={(e) => setDepartureDay(e.target.value)}
          fullWidth
        />
      </Grid>
      <Grid item xs={4} sm={2}>
        <TextField
          id="time"
          type="time"
          value={departureTime}
          onChange={(e) => setDepartureTime(e.target.value)}
          fullWidth
        />
      </Grid>
      <Grid item sm={6} container justifyContent="right" alignItems="center">
        <Button variant="contained" type="submit" disabled={!formValid} onClick={handleSearchClick}>
          Search
        </Button>
      </Grid>
    </Grid>
  );
};

export default SearchMask;
