import React, { useContext, useEffect, useState } from 'react';
import {
  Alert,
  Typography,
  Box,
  Button,
  Paper,
  Switch,
  FormControlLabel,
  FormControl,
  Select,
  MenuItem,
  Chip,
  IconButton,
  SelectChangeEvent,
} from '@mui/material';
import { Add as AddIcon, Close as CloseIcon } from '@mui/icons-material';
import { useMutation, useQuery } from 'urql';
import { AuthContext } from '../providers/AuthProvider';
import { UserTravelPreferencesQuery, UpdateTravelPreferences } from '../api/user';
import useAlert from '../hooks/useAlert';
import { AlertSeverity } from '../providers/AlertProvider';
import LoadingStatus from './LoadingStatus';
import {
  LoyaltyCardInput,
  AGE_GROUP_OPTIONS,
  LOYALTY_CARD_OPTIONS,
  cardToKey,
  keyToCard,
  cardLabel,
} from '../utils/travelPreferences';

type LoyaltyCard = LoyaltyCardInput;

const sectionTitleSx = {
  display: 'block',
  mb: 1.75,
  pb: 1.25,
  borderBottom: 1,
  borderColor: 'divider',
};

const fieldLabelSx = {
  mb: 0.5,
};

interface TravelPreferencesProps {
  onDirtyChange?: (dirty: boolean) => void;
}

interface PreferencesSnapshot {
  loyaltyCards: LoyaltyCard[];
  ageGroup: string;
  deutschlandTicketDiscount: boolean;
}

function samePreferences(left: PreferencesSnapshot, right: PreferencesSnapshot): boolean {
  const leftKeys = left.loyaltyCards.map(cardToKey).sort().join('|');
  const rightKeys = right.loyaltyCards.map(cardToKey).sort().join('|');
  return (
    leftKeys === rightKeys &&
    left.ageGroup === right.ageGroup &&
    left.deutschlandTicketDiscount === right.deutschlandTicketDiscount
  );
}

const TravelPreferences: React.FC<TravelPreferencesProps> = ({ onDirtyChange }) => {
  const { user } = useContext(AuthContext);
  const { addAlert } = useAlert();
  const userId = user?.['custom:id'];

  const [{ data, fetching, error }] = useQuery({
    query: UserTravelPreferencesQuery,
    variables: { id: userId },
    pause: !userId,
  });

  const [, updateTravelPreferences] = useMutation(UpdateTravelPreferences);

  const [loyaltyCards, setLoyaltyCards] = useState<LoyaltyCard[]>([]);
  const [ageGroup, setAgeGroup] = useState<string>('ADULT');
  const [deutschlandTicketDiscount, setDeutschlandTicketDiscount] = useState(false);
  const [savedPreferences, setSavedPreferences] = useState<PreferencesSnapshot>({
    loyaltyCards: [],
    ageGroup: 'ADULT',
    deutschlandTicketDiscount: false,
  });
  const [saving, setSaving] = useState(false);
  const dirty = !samePreferences({ loyaltyCards, ageGroup, deutschlandTicketDiscount }, savedPreferences);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Sync state from server data
  useEffect(() => {
    if (data?.user) {
      const snapshot: PreferencesSnapshot = {
        loyaltyCards: data.user.loyaltyCards ?? [],
        ageGroup: data.user.ageGroup ?? 'ADULT',
        deutschlandTicketDiscount: data.user.deutschlandTicketDiscount ?? false,
      };
      setLoyaltyCards(snapshot.loyaltyCards);
      setAgeGroup(snapshot.ageGroup);
      setDeutschlandTicketDiscount(snapshot.deutschlandTicketDiscount);
      setSavedPreferences(snapshot);
    }
  }, [data]);

  const handleAddCard = () => {
    // Find first card not already selected
    const usedKeys = new Set(loyaltyCards.map(cardToKey));
    const available = LOYALTY_CARD_OPTIONS.find((opt) => !usedKeys.has(opt.key));
    if (available) {
      setLoyaltyCards([...loyaltyCards, available.card]);
    }
  };

  const handleRemoveCard = (index: number) => {
    setLoyaltyCards(loyaltyCards.filter((_, i) => i !== index));
  };

  const handleCardChange = (index: number, key: string) => {
    const card = keyToCard(key);
    if (card) {
      const updated = [...loyaltyCards];
      updated[index] = card;
      setLoyaltyCards(updated);
    }
  };

  const handleAgeGroupChange = (e: SelectChangeEvent) => {
    setAgeGroup(e.target.value);
  };

  const handleDTicketToggle = (_event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    setDeutschlandTicketDiscount(checked);
  };

  const handleSave = async () => {
    setSaving(true);
    const snapshot: PreferencesSnapshot = { loyaltyCards, ageGroup, deutschlandTicketDiscount };
    const result = await updateTravelPreferences({
      userId,
      // Explicitly pick only the input fields — urql adds __typename to query
      // results and LoyaltyCardInput does not accept that field.
      loyaltyCards:
        loyaltyCards.length > 0
          ? loyaltyCards.map((card) => ({ type: card.type, discount: card.discount, class: card.class }))
          : null,
      ageGroup: ageGroup || null,
      deutschlandTicketDiscount,
    });
    setSaving(false);

    if (result.error) {
      addAlert('Failed to save travel preferences. Please try again.', AlertSeverity.Error);
    } else {
      setSavedPreferences(snapshot);
      addAlert('Travel preferences saved.', AlertSeverity.Success);
    }
  };

  if (fetching) {
    return <LoadingStatus label="Loading travel preferences…" inline minHeight={48} />;
  }

  if (error) {
    return <Alert severity="error">Could not load your travel preferences. Please try again later.</Alert>;
  }

  const usedKeys = new Set(loyaltyCards.map(cardToKey));
  const canAddMore = LOYALTY_CARD_OPTIONS.some((opt) => !usedKeys.has(opt.key));

  return (
    <Paper elevation={0} sx={{ border: 1, borderColor: 'divider', borderRadius: 3, p: 2.5 }}>
      <Typography component="h2" variant="sectionTitle" sx={sectionTitleSx}>
        Travel preferences
      </Typography>

      {/* Loyalty cards */}
      <Box sx={{ mb: 2 }}>
        <Typography variant="fieldLabel" sx={fieldLabelSx}>
          Discount cards
        </Typography>

        {loyaltyCards.length === 0 && (
          <Typography sx={{ fontSize: 12, color: 'text.secondary', mb: 1 }}>No discount cards configured</Typography>
        )}

        {loyaltyCards.map((card, index) => (
          <Box key={index} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <FormControl size="small" sx={{ flex: 1 }}>
              <Select
                inputProps={{ 'aria-label': `Discount card ${index + 1}` }}
                value={cardToKey(card)}
                onChange={(e) => handleCardChange(index, e.target.value)}
                displayEmpty
                sx={{ fontSize: 13 }}
              >
                {LOYALTY_CARD_OPTIONS.filter((opt) => opt.key === cardToKey(card) || !usedKeys.has(opt.key)).map(
                  (opt) => (
                    <MenuItem key={opt.key} value={opt.key} sx={{ fontSize: 13 }}>
                      {opt.label}
                    </MenuItem>
                  )
                )}
              </Select>
            </FormControl>
            <IconButton
              size="small"
              aria-label={`Remove ${cardLabel(card)}`}
              onClick={() => handleRemoveCard(index)}
              sx={{ color: 'text.secondary' }}
            >
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Box>
        ))}

        {canAddMore && (
          <Button
            size="small"
            startIcon={<AddIcon sx={{ fontSize: '14px !important' }} />}
            onClick={handleAddCard}
            sx={{ fontSize: 12, textTransform: 'none', color: 'text.secondary', mt: 0.5 }}
          >
            Add discount card
          </Button>
        )}
      </Box>

      {/* Age group */}
      <Box sx={{ mb: 2 }}>
        <Typography
          id="travel-age-group-label"
          variant="fieldLabel"
          sx={{ ...fieldLabelSx, cursor: 'pointer' }}
          onClick={() => document.getElementById('travel-age-group')?.focus()}
        >
          Age group
        </Typography>
        <FormControl size="small" fullWidth>
          <Select
            id="travel-age-group"
            labelId="travel-age-group-label"
            value={ageGroup}
            onChange={handleAgeGroupChange}
            sx={{ fontSize: 13 }}
          >
            {AGE_GROUP_OPTIONS.map((opt) => (
              <MenuItem key={opt.value} value={opt.value} sx={{ fontSize: 13 }}>
                {opt.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>

      {/* Deutschlandticket */}
      <FormControlLabel
        control={<Switch checked={deutschlandTicketDiscount} onChange={handleDTicketToggle} color="secondary" />}
        label={
          <Box>
            <Typography sx={{ fontSize: 13, fontWeight: 600, color: 'text.primary' }}>Deutschlandticket</Typography>
            <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
              Regional transport costs are deducted from prices
            </Typography>
          </Box>
        }
        labelPlacement="start"
        sx={{ m: 0, mb: 2, width: '100%', justifyContent: 'space-between' }}
      />

      {/* Active preferences summary */}
      {(loyaltyCards.length > 0 || ageGroup !== 'ADULT' || deutschlandTicketDiscount) && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 2 }}>
          {loyaltyCards.map((card, i) => (
            <Chip key={i} label={cardLabel(card)} size="small" sx={{ fontSize: 11 }} />
          ))}
          {ageGroup !== 'ADULT' && (
            <Chip
              label={AGE_GROUP_OPTIONS.find((o) => o.value === ageGroup)?.label}
              size="small"
              sx={{ fontSize: 11 }}
            />
          )}
          {deutschlandTicketDiscount && <Chip label="Deutschlandticket" size="small" sx={{ fontSize: 11 }} />}
        </Box>
      )}

      {/* Save button */}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', pt: 1.75, borderTop: 1, borderColor: 'divider' }}>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={!dirty || saving || !userId}
          sx={{ textTransform: 'none', fontWeight: 600 }}
        >
          {saving ? 'Saving…' : 'Save preferences'}
        </Button>
      </Box>
    </Paper>
  );
};

export default TravelPreferences;
