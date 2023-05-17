import React from 'react';
import { Typography, TableContainer, Table, TableHead, TableBody, TableRow, TableCell, useTheme } from '@mui/material';

interface Props {
  searchData: any;
  searchResult: any;
}

const SearchResult: React.FC<Props> = ({ searchData, searchResult }) => {
  const theme = useTheme();

  const formatDateTime = (dateTime: string) => {
    const date = new Date(dateTime);
    const formattedDate = date.toLocaleDateString(undefined, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
    const formattedTime = date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${formattedDate} ${formattedTime}`;
  };

  return (
    <>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
        {`${searchData.departure} to ${searchData.destination}, ${formatDateTime(
          searchData.date + 'T' + searchData.time
        )}`}
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
              <TableRow
                key={index}
                sx={{
                  backgroundColor: index % 2 === 0 ? theme.palette.background.default : theme.palette.background.paper,
                }}
              >
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
