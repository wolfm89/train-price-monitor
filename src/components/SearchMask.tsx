import React, { useState } from 'react';
import { Button, TextField, Grid, Typography } from '@mui/material';

interface Props {
    onSearch: (searchData: any, searchResult: any) => void;
}

const SearchMask: React.FC<Props> = ({ onSearch }) => {
    const [departure, setDeparture] = useState('');
    const [destination, setDestination] = useState('');
    const [date, setDate] = useState('');
    const [time, setTime] = useState('');
    const [formValid, setFormValid] = useState(false);

    const handleSearchClick = (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();

        const searchData = {
            departure,
            destination,
            date,
            time
        };

        const searchResult = [
            {
                departureTime: '10:16',
                arrivalTime: '13:36',
                meansOfTransport: ['EC, RJ, R'],
                currentPrice: 64.90
            },
            {
                departureTime: '11:18',
                arrivalTime: '14:48',
                meansOfTransport: ['RJ, R'],
                currentPrice: 52.50
            }
        ];

        onSearch(searchData, searchResult);
    };

    // Update form validity based on input fields
    React.useEffect(() => {
        setFormValid(departure.trim() !== '' && destination.trim() !== '' && date.trim() !== '' && time.trim() !== '');
    }, [departure, destination, date, time]);

    return (
        <form onSubmit={handleSearchClick}>
            <Grid container spacing={2}>
                <Grid item xs={3} sm={1} container justifyContent="flex-end" alignItems="center">
                    <Typography>From:</Typography>
                </Grid>
                <Grid item xs={9} sm={5}>
                    <TextField
                        id="departure"
                        value={departure}
                        onChange={(e) => setDeparture(e.target.value)}
                        fullWidth
                    />
                </Grid>
                <Grid item xs={3} sm={1} container justifyContent="flex-end" alignItems="center">
                    <Typography>To:</Typography>
                </Grid>
                <Grid item xs={9} sm={5}>
                    <TextField
                        id="destination"
                        value={destination}
                        onChange={(e) => setDestination(e.target.value)}
                        fullWidth
                    />
                </Grid>
                <Grid item xs={3} sm={1} container justifyContent="flex-end" alignItems="center">
                    <Typography>Departure:</Typography>
                </Grid>
                <Grid item xs={5} sm={3}>
                    <TextField
                        id="date"
                        type="date"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                        fullWidth
                    />
                </Grid>
                <Grid item xs={4} sm={2}>
                    <TextField
                        id="time"
                        type="time"
                        value={time}
                        onChange={(e) => setTime(e.target.value)}
                        fullWidth
                    />
                </Grid>
                <Grid item sm={6} container justifyContent="right" alignItems="center">
                    <Button variant="contained" type="submit" disabled={!formValid}>
                        Search
                    </Button>
                </Grid>
            </Grid>
        </form>
    );
};

export default SearchMask;
