import React, { useContext, useState } from 'react';
import {
  Typography,
  TableContainer,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  useTheme,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  CircularProgress,
  useMediaQuery,
} from '@mui/material';
import AlarmAddIcon from '@mui/icons-material/AlarmAdd';
import { WatchJourney } from '../api/journey';
import { useMutation } from 'urql';
import { AuthContext } from '../providers/AuthProvider';
import useAlert from '../hooks/useAlert';
import { AlertSeverity } from '../providers/AlertProvider';

// Define the Journey type
interface Journey {
  refreshToken: string;
  from: string;
  to: string;
  departure: string;
  arrival: string;
  means: string[];
  price?: number;
}

interface Props {
  searchData: any;
  searchResult: Journey[];
}

const SearchResult: React.FC<Props> = ({ searchData, searchResult }) => {
  const theme = useTheme();
  const isScreenSmall = useMediaQuery(theme.breakpoints.down('sm'));
  const { addAlert } = useAlert();
  const [openModal, setOpenModal] = useState(false);
  const [selectedJourney, setSelectedJourney] = useState<Journey | null>(null);
  const [limitPrice, setLimitPrice] = useState('');
  const { user } = useContext(AuthContext);
  const [, watchJourney] = useMutation(WatchJourney);
  const [loading, setLoading] = useState(false);

  const handleWatchClick = (journey: Journey) => {
    setSelectedJourney(journey);
    setOpenModal(true);
  };

  const handleCloseModal = () => {
    setOpenModal(false);
    setSelectedJourney(null); // Clear selected journey when the modal is closed
    setLimitPrice(''); // Clear limit price when the modal is closed
  };

  const handleConfirmWatch = () => {
    setLoading(true);
    const { refreshToken } = selectedJourney!;
    watchJourney({
      userId: user?.['custom:id'],
      refreshToken: refreshToken,
      limitPrice: parseFloat(limitPrice),
    })
      .then((result) => {
        setLoading(false);
        setSelectedJourney(null);
        if (result.error) {
          addAlert(result.error.message, AlertSeverity.Error);
        } else {
          addAlert('Journey successfully added to watchlist!', AlertSeverity.Success);
        }
      })
      .catch((reason) => {
        console.log(reason);
        setLoading(false);
      });

    setOpenModal(false);
    setLimitPrice(''); // Clear limit price when the modal is closed
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && isValidLimitPrice()) {
      handleConfirmWatch();
    }
  };

  const isValidLimitPrice = () => {
    const floatValue = parseFloat(limitPrice);
    return !isNaN(floatValue) && floatValue > (selectedJourney?.price ?? 0);
  };

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

  function formatTimeDifference(startDate: Date, endDate: Date): string {
    const differenceMilliseconds = endDate.getTime() - startDate.getTime();
    const differenceHours = differenceMilliseconds / (1000 * 60 * 60);

    const hours = Math.floor(differenceHours);
    const minutes = Math.round((differenceHours - hours) * 60);

    return `${hours} h ${minutes} min`;
  }

  return (
    <>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
        {`${searchData.departure} to ${searchData.destination}, ${formatDateTime(
          searchData.date + 'T' + searchData.time
        )}`}
      </Typography>
      <TableContainer>
        <Table size={isScreenSmall ? 'small' : 'medium'}>
          <TableHead>
            <TableRow>
              <TableCell>Departure Time</TableCell>
              <TableCell>Arrival Time</TableCell>
              <TableCell>Duration</TableCell>
              <TableCell>Means{!isScreenSmall && ' of Transport'}</TableCell>
              <TableCell>Price</TableCell>
              <TableCell></TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {searchResult.map((result: Journey, index: number) => (
              <TableRow
                key={index}
                sx={{
                  backgroundColor: index % 2 === 0 ? theme.palette.background.default : theme.palette.background.paper,
                }}
              >
                <TableCell>{formatDateTime(result.departure)}</TableCell>
                <TableCell>{formatDateTime(result.arrival)}</TableCell>
                <TableCell>{formatTimeDifference(new Date(result.departure), new Date(result.arrival))}</TableCell>
                <TableCell>
                  {result.means.map((mean: string) => (mean === 'walk' ? '\u{1F6B6}' : mean)).join(' \u{2192} ')}
                </TableCell>
                <TableCell>{result.price ? `€${result.price.toFixed(2)}` : 'n/a'}</TableCell>
                <TableCell>
                  {result.price && (
                    <Button
                      variant="outlined"
                      color="primary"
                      disabled={loading && selectedJourney?.refreshToken === result.refreshToken}
                      onClick={() => handleWatchClick(result)}
                    >
                      {loading && selectedJourney?.refreshToken === result.refreshToken ? (
                        <CircularProgress size={24} />
                      ) : (
                        <>
                          <AlarmAddIcon />
                          {!isScreenSmall && <span style={{ marginLeft: '8px' }}>Watch</span>}
                        </>
                      )}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Watch Modal */}
      <Dialog open={openModal} onClose={handleCloseModal}>
        <DialogTitle>Set Limit Price</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="textSecondary" sx={{ marginBottom: 2 }}>
            Current Price: {selectedJourney?.price ? `€${selectedJourney.price.toFixed(2)}` : 'n/a'}
          </Typography>
          <TextField
            label="Limit Price"
            type="number"
            value={limitPrice}
            onChange={(e) => setLimitPrice(e.target.value)}
            onKeyPress={handleKeyPress}
            error={!isValidLimitPrice() && limitPrice !== ''} // Show error only when limitPrice is not empty
            helperText={!isValidLimitPrice() && limitPrice !== '' ? 'Invalid limit price' : ''}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseModal} color="primary">
            Cancel
          </Button>
          <Button onClick={handleConfirmWatch} color="primary" disabled={!isValidLimitPrice()}>
            Confirm
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default SearchResult;
