import React from 'react';
import { Typography, TableContainer, Table, TableHead, TableBody, TableRow, TableCell, useTheme } from '@mui/material';

interface Props {
    searchData: any;
    searchResult: any;
}

const SearchResult: React.FC<Props> = ({ searchData, searchResult }) => {
    const theme = useTheme();

    return (
        <>
            <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
                {`${searchData.departure} to ${searchData.destination}, ${searchData.date} ${searchData.time}`}
            </Typography>
            <TableContainer>
                <Table>
                    <TableHead>
                        <TableRow>
                            <TableCell>Departure Time</TableCell>
                            <TableCell>Means of Transport</TableCell>
                            <TableCell>Arrival Time</TableCell>
                            <TableCell>Price</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {searchResult.map((result: any, index: number) => (
                            <TableRow key={index} sx={{ backgroundColor: index % 2 === 0 ? theme.palette.background.default : theme.palette.background.paper }}>
                                <TableCell>{result.departureTime}</TableCell>
                                <TableCell>{result.meansOfTransport.join(' ')}</TableCell>
                                <TableCell>{result.arrivalTime}</TableCell>
                                <TableCell>{`€${result.currentPrice.toFixed(2)}`}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
        </>
    );
};

export default SearchResult;
