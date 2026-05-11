import React, { useContext, useEffect, useState } from 'react';
import {
  Typography,
  Box,
  Button,
  Paper,
  Switch,
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

interface LoyaltyCard {
  type: string;
  discount?: number | null;
  class?: number | null;
}

const AGE_GROUP_OPTIONS = [
  { value: 'BABY', label: 'Baby (0-5)' },
  { value: 'CHILD', label: 'Child (6-14)' },
  { value: 'YOUTH', label: 'Youth (15-26)' },
  { value: 'ADULT', label: 'Adult' },
  { value: 'SENIOR', label: 'Senior (65+)' },
];

interface LoyaltyCardOption {
  key: string;
  label: string;
  card: LoyaltyCard;
}

const LOYALTY_CARD_OPTIONS: LoyaltyCardOption[] = [
  { key: 'BC25_2', label: 'Bahncard 25, 2. Klasse', card: { type: 'BAHNCARD', discount: 25, class: 2 } },
  { key: 'BC25_1', label: 'Bahncard 25, 1. Klasse', card: { type: 'BAHNCARD', discount: 25, class: 1 } },
  { key: 'BC50_2', label: 'Bahncard 50, 2. Klasse', card: { type: 'BAHNCARD', discount: 50, class: 2 } },
  { key: 'BC50_1', label: 'Bahncard 50, 1. Klasse', card: { type: 'BAHNCARD', discount: 50, class: 1 } },
  { key: 'VORTEILSCARD', label: 'Vorteilscard (AT)', card: { type: 'VORTEILSCARD' } },
  { key: 'AT_KLIMATICKET', label: 'Klimaticket (AT)', card: { type: 'AT_KLIMATICKET' } },
  { key: 'HALBTAXABO', label: 'Halbtax (CH)', card: { type: 'HALBTAXABO' } },
  { key: 'GA_1', label: 'General-Abonnement 1. Kl. (CH)', card: { type: 'GENERALABONNEMENT', class: 1 } },
  { key: 'GA_2', label: 'General-Abonnement 2. Kl. (CH)', card: { type: 'GENERALABONNEMENT', class: 2 } },
  { key: 'VOORDEELURENABO', label: 'Voordeelurenabo (NL)', card: { type: 'VOORDEELURENABO' } },
  { key: 'NL_40', label: 'NL-40% (NL)', card: { type: 'NL_40' } },
  { key: 'SHCARD', label: 'SH-Card', card: { type: 'SHCARD' } },
];

function cardToKey(card: LoyaltyCard): string {
  const match = LOYALTY_CARD_OPTIONS.find(
    (opt) =>
      opt.card.type === card.type &&
      (opt.card.discount ?? null) === (card.discount ?? null) &&
      (opt.card.class ?? null) === (card.class ?? null)
  );
  return match?.key ?? '';
}

function keyToCard(key: string): LoyaltyCard | undefined {
  return LOYALTY_CARD_OPTIONS.find((opt) => opt.key === key)?.card;
}

function cardLabel(card: LoyaltyCard): string {
  const match = LOYALTY_CARD_OPTIONS.find(
    (opt) =>
      opt.card.type === card.type &&
      (opt.card.discount ?? null) === (card.discount ?? null) &&
      (opt.card.class ?? null) === (card.class ?? null)
  );
  return match?.label ?? card.type;
}

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

const TravelPreferences: React.FC = () => {
  const { user } = useContext(AuthContext);
  const { addAlert } = useAlert();
  const userId = user?.['custom:id'];

  const [{ data, fetching }] = useQuery({
    query: UserTravelPreferencesQuery,
    variables: { id: userId },
    pause: !userId,
  });

  const [, updateTravelPreferences] = useMutation(UpdateTravelPreferences);

  const [loyaltyCards, setLoyaltyCards] = useState<LoyaltyCard[]>([]);
  const [ageGroup, setAgeGroup] = useState<string>('ADULT');
  const [deutschlandTicketDiscount, setDeutschlandTicketDiscount] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Sync state from server data
  useEffect(() => {
    if (data?.user) {
      setLoyaltyCards(data.user.loyaltyCards ?? []);
      setAgeGroup(data.user.ageGroup ?? 'ADULT');
      setDeutschlandTicketDiscount(data.user.deutschlandTicketDiscount ?? false);
      setDirty(false);
    }
  }, [data]);

  const handleAddCard = () => {
    // Find first card not already selected
    const usedKeys = new Set(loyaltyCards.map(cardToKey));
    const available = LOYALTY_CARD_OPTIONS.find((opt) => !usedKeys.has(opt.key));
    if (available) {
      setLoyaltyCards([...loyaltyCards, available.card]);
      setDirty(true);
    }
  };

  const handleRemoveCard = (index: number) => {
    setLoyaltyCards(loyaltyCards.filter((_, i) => i !== index));
    setDirty(true);
  };

  const handleCardChange = (index: number, key: string) => {
    const card = keyToCard(key);
    if (card) {
      const updated = [...loyaltyCards];
      updated[index] = card;
      setLoyaltyCards(updated);
      setDirty(true);
    }
  };

  const handleAgeGroupChange = (e: SelectChangeEvent) => {
    setAgeGroup(e.target.value);
    setDirty(true);
  };

  const handleDTicketToggle = (_event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    setDeutschlandTicketDiscount(checked);
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
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
      addAlert('Travel preferences saved.', AlertSeverity.Success);
      setDirty(false);
    }
  };

  if (fetching) {
    return null;
  }

  const usedKeys = new Set(loyaltyCards.map(cardToKey));
  const canAddMore = LOYALTY_CARD_OPTIONS.some((opt) => !usedKeys.has(opt.key));

  return (
    <Paper elevation={0} sx={{ border: 1, borderColor: 'divider', borderRadius: 3, p: 2.5 }}>
      <Typography variant="sectionTitle" sx={sectionTitleSx}>
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
            <IconButton size="small" onClick={() => handleRemoveCard(index)} sx={{ color: 'text.secondary' }}>
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
        <Typography variant="fieldLabel" sx={fieldLabelSx}>
          Age group
        </Typography>
        <FormControl size="small" fullWidth>
          <Select value={ageGroup} onChange={handleAgeGroupChange} sx={{ fontSize: 13 }}>
            {AGE_GROUP_OPTIONS.map((opt) => (
              <MenuItem key={opt.value} value={opt.value} sx={{ fontSize: 13 }}>
                {opt.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>

      {/* Deutschlandticket */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 2,
        }}
      >
        <Box>
          <Typography sx={{ fontSize: 13, fontWeight: 600, color: 'text.primary' }}>Deutschlandticket</Typography>
          <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
            Regional transport costs are deducted from prices
          </Typography>
        </Box>
        <Switch checked={deutschlandTicketDiscount} onChange={handleDTicketToggle} color="secondary" />
      </Box>

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
          disabled={!dirty || saving}
          sx={{ textTransform: 'none', fontWeight: 600 }}
        >
          {saving ? 'Saving...' : 'Save preferences'}
        </Button>
      </Box>
    </Paper>
  );
};

export default TravelPreferences;
