import React, { useContext, useState } from 'react';
import {
  Typography,
  Button,
  Box,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  CircularProgress,
  Chip,
  Paper,
} from '@mui/material';
import { Train as TrainIcon } from '@mui/icons-material';
import NavigateBeforeIcon from '@mui/icons-material/NavigateBefore';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import { MonitorJourney } from '../api/journey';
import { useMutation } from 'urql';
import { AuthContext } from '../providers/AuthProvider';
import useAlert from '../hooks/useAlert';
import { AlertSeverity } from '../providers/AlertProvider';

export interface Journey {
  refreshToken: string;
  fromId: string;
  toId: string;
  departure: string;
  arrival: string;
  means: string[];
  price?: number;
}

export interface SearchData {
  departure: string;
  destination: string;
  date: string;
  time: string;
}

interface Props {
  searchData: SearchData;
  searchResult: Journey[];
  onNavigateEarlier?: () => void;
  onNavigateLater?: () => void;
  navigatingDirection?: 'earlier' | 'later' | null;
}

const MONO_FONT = '"IBM Plex Mono", monospace';

const SearchResult: React.FC<Props> = ({
  searchData: _searchData,
  searchResult,
  onNavigateEarlier,
  onNavigateLater,
  navigatingDirection,
}) => {
  const { addAlert } = useAlert();
  const [openModal, setOpenModal] = useState(false);
  const [selectedJourney, setSelectedJourney] = useState<Journey | null>(null);
  const [limitPrice, setLimitPrice] = useState('');
  const { user } = useContext(AuthContext);
  const [, monitorJourney] = useMutation(MonitorJourney);
  const [loading, setLoading] = useState(false);

  const handleWatchClick = (journey: Journey) => {
    setSelectedJourney(journey);
    setOpenModal(true);
  };

  const handleCloseModal = () => {
    setOpenModal(false);
    setTimeout(() => {
      setSelectedJourney(null);
      setLimitPrice('');
    }, 100);
  };

  const handleConfirmWatch = () => {
    setLoading(true);
    const { refreshToken, departure, fromId, toId } = selectedJourney!;
    const expires = new Date(departure);
    expires.setHours(expires.getHours() - 1);

    monitorJourney({
      userId: user?.['custom:id'],
      refreshToken: refreshToken,
      limitPrice: parseFloat(limitPrice),
      expires: expires,
      fromId: fromId,
      toId: toId,
      departure: departure,
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
      .catch(() => {
        setLoading(false);
      });

    setOpenModal(false);
    setLimitPrice('');
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

  const formatTime = (dateTime: string) =>
    new Date(dateTime).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  const formatDuration = (dep: string, arr: string) => {
    const mins = Math.round((new Date(arr).getTime() - new Date(dep).getTime()) / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}m`;
  };

  return (
    <>
      <Typography
        sx={{
          fontSize: 11,
          fontWeight: 700,
          color: 'text.secondary',
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
          mb: 1.25,
        }}
      >
        {searchResult.length} connection{searchResult.length !== 1 ? 's' : ''} found
      </Typography>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {searchResult.map((result: Journey, index: number) => (
          <Paper
            key={index}
            elevation={0}
            sx={{
              border: 1,
              borderColor: 'divider',
              borderRadius: 2,
              px: 2,
              py: 1.75,
              display: 'flex',
              alignItems: 'center',
              gap: { xs: 1, sm: 1.75 },
              cursor: 'pointer',
              transition: 'border-color 0.15s',
              '&:hover': { borderColor: '#a3c485' },
              flexWrap: { xs: 'wrap', sm: 'nowrap' },
            }}
          >
            {/* Times */}
            <Box sx={{ minWidth: 84 }}>
              <Typography sx={{ fontFamily: MONO_FONT, fontSize: 17, fontWeight: 500, lineHeight: 1 }}>
                {formatTime(result.departure)}
              </Typography>
              <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.25 }}>
                → {formatTime(result.arrival)}
              </Typography>
            </Box>

            {/* Route line */}
            <Box sx={{ flex: 1, display: { xs: 'none', sm: 'flex' }, alignItems: 'center', gap: '5px' }}>
              <Box sx={{ width: 5, height: 5, borderRadius: '50%', bgcolor: 'divider', flexShrink: 0 }} />
              <Box
                sx={{
                  flex: 1,
                  height: '1px',
                  backgroundImage: (theme) =>
                    `repeating-linear-gradient(90deg, ${theme.palette.divider} 0, ${theme.palette.divider} 4px, transparent 4px, transparent 8px)`,
                }}
              />
              <TrainIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
              <Box
                sx={{
                  flex: 1,
                  height: '1px',
                  backgroundImage: (theme) =>
                    `repeating-linear-gradient(90deg, ${theme.palette.divider} 0, ${theme.palette.divider} 4px, transparent 4px, transparent 8px)`,
                }}
              />
              <Box sx={{ width: 5, height: 5, borderRadius: '50%', bgcolor: 'divider', flexShrink: 0 }} />
            </Box>

            {/* Duration */}
            <Chip
              label={formatDuration(result.departure, result.arrival)}
              size="small"
              variant="outlined"
              sx={{ fontSize: 11, fontWeight: 500, height: 24 }}
            />

            {/* Means */}
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', minWidth: 70 }}>
              {result.means.map((mean: string, i: number) => (
                <Chip
                  key={i}
                  label={mean === 'walk' ? '\u{1F6B6}' : mean}
                  size="small"
                  sx={{
                    height: 22,
                    fontSize: 10,
                    fontWeight: 700,
                    borderRadius: '4px',
                  }}
                />
              ))}
            </Box>

            {/* Price */}
            <Box sx={{ textAlign: 'right', minWidth: 68 }}>
              <Typography sx={{ fontFamily: MONO_FONT, fontSize: 16, fontWeight: 500 }}>
                {result.price ? `€${result.price.toFixed(2)}` : 'n/a'}
              </Typography>
            </Box>

            {/* Watch button */}
            {result.price && (
              <Button
                size="small"
                disabled={loading && selectedJourney?.refreshToken === result.refreshToken}
                onClick={() => handleWatchClick(result)}
                sx={{
                  bgcolor: 'secondary.light',
                  color: 'secondary.dark',
                  border: '1.5px solid',
                  borderColor: '#a3c485',
                  borderRadius: '7px',
                  px: 1.5,
                  py: 0.5,
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: 'none',
                  whiteSpace: 'nowrap',
                  '&:hover': { bgcolor: '#a3c485', color: '#fff' },
                }}
              >
                {loading && selectedJourney?.refreshToken === result.refreshToken ? (
                  <CircularProgress size={16} />
                ) : (
                  '+ Watch'
                )}
              </Button>
            )}
          </Paper>
        ))}
      </Box>

      {(onNavigateEarlier || onNavigateLater) && (
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 2, mb: 1 }}>
          {onNavigateEarlier ? (
            <Button
              variant="outlined"
              size="small"
              onClick={onNavigateEarlier}
              disabled={!!navigatingDirection}
              startIcon={navigatingDirection === 'earlier' ? <CircularProgress size={16} /> : <NavigateBeforeIcon />}
              sx={{ textTransform: 'none' }}
            >
              Earlier trains
            </Button>
          ) : (
            <span />
          )}
          {onNavigateLater && (
            <Button
              variant="outlined"
              size="small"
              onClick={onNavigateLater}
              disabled={!!navigatingDirection}
              endIcon={navigatingDirection === 'later' ? <CircularProgress size={16} /> : <NavigateNextIcon />}
              sx={{ textTransform: 'none' }}
            >
              Later trains
            </Button>
          )}
        </Box>
      )}

      {/* Watch Modal */}
      <Dialog open={openModal} onClose={handleCloseModal}>
        <DialogTitle>Set Limit Price</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
            Current Price: {selectedJourney?.price ? `€${selectedJourney.price.toFixed(2)}` : 'n/a'}
          </Typography>
          <TextField
            label="Limit Price"
            type="number"
            value={limitPrice}
            onChange={(e) => setLimitPrice(e.target.value)}
            onKeyPress={handleKeyPress}
            error={!isValidLimitPrice() && limitPrice !== ''}
            helperText={!isValidLimitPrice() && limitPrice !== '' ? 'Invalid limit price' : ''}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseModal}>Cancel</Button>
          <Button onClick={handleConfirmWatch} disabled={!isValidLimitPrice()}>
            Confirm
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default SearchResult;
