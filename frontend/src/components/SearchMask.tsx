import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  TextField,
  Grid,
  Typography,
  Autocomplete,
  Paper,
  Box,
  InputAdornment,
  Collapse,
  ToggleButton,
  ToggleButtonGroup,
  Chip,
  FormControl,
  Select,
  MenuItem,
  Menu,
  Switch,
  SelectChangeEvent,
} from '@mui/material';
import {
  Search as SearchIcon,
  LocationOn as LocationOnIcon,
  CalendarToday as CalendarTodayIcon,
  AccessTime as AccessTimeIcon,
  PedalBike as BikeIcon,
  Add as AddIcon,
  PersonOutline as PersonIcon,
  TuneRounded as TuneIcon,
} from '@mui/icons-material';
import { useQuery } from 'urql';
import debounce from 'lodash/debounce';
import { LocationSearchQuery } from '../api/location';
import { SearchData } from './SearchResult';
import {
  LoyaltyCardInput,
  AGE_GROUP_OPTIONS,
  LOYALTY_CARD_OPTIONS,
  cardToKey,
  keyToCard,
  cardLabel,
} from '../utils/travelPreferences';

export interface ProductFilter {
  nationalExpress?: boolean;
  national?: boolean;
  regionalExpress?: boolean;
  regional?: boolean;
  suburban?: boolean;
  bus?: boolean;
  ferry?: boolean;
  subway?: boolean;
  tram?: boolean;
  taxi?: boolean;
}

export interface JourneySearchOptions {
  firstClass?: boolean;
  products?: ProductFilter;
  transfers?: number;
  transferTime?: number;
  bike?: boolean;
  results?: number;
  loyaltyCards?: LoyaltyCardInput[];
  ageGroup?: string;
  deutschlandTicketDiscount?: boolean;
}

interface Props {
  setSearchData: (searchData: SearchData) => void;
  onSearch: (from: string, to: string, departure: string, options?: JourneySearchOptions) => void;
  initialLoyaltyCards?: LoyaltyCardInput[];
  initialAgeGroup?: string;
  initialDeutschlandTicketDiscount?: boolean;
}

interface Location {
  id: string;
  name: string;
}

const ALL_PRODUCT_KEYS: (keyof ProductFilter)[] = [
  'nationalExpress',
  'national',
  'regionalExpress',
  'regional',
  'suburban',
  'bus',
  'ferry',
  'subway',
  'tram',
  'taxi',
];

const PRODUCT_TOGGLES: { keys: (keyof ProductFilter)[]; label: string }[] = [
  { keys: ['nationalExpress'], label: 'ICE' },
  { keys: ['national'], label: 'IC/EC' },
  { keys: ['regionalExpress', 'regional'], label: 'RE/RB' },
  { keys: ['suburban'], label: 'S-Bahn' },
  { keys: ['bus'], label: 'Bus' },
  { keys: ['ferry'], label: 'Ferry' },
  { keys: ['subway'], label: 'U-Bahn' },
  { keys: ['tram'], label: 'Tram' },
  { keys: ['taxi'], label: 'Taxi' },
];

const TRANSFER_OPTIONS = [
  { value: -1, label: 'Any' },
  { value: 0, label: 'Direct only' },
  { value: 1, label: '1 transfer' },
  { value: 2, label: '2 transfers' },
  { value: 3, label: '3 transfers' },
  { value: 5, label: '5 transfers' },
];

const fieldLabelSx = {
  display: 'block',
  mb: 0.5,
};

function dedupLocations(items: readonly Location[]): Location[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

const SearchMask: React.FC<Props> = ({
  setSearchData,
  onSearch,
  initialLoyaltyCards,
  initialAgeGroup,
  initialDeutschlandTicketDiscount,
}) => {
  const [from, setFrom] = useState<Location | null>(null);
  const [fromInput, setFromInput] = useState<string>('');
  const [fromSuggestions, setFromSuggestions] = useState<readonly Location[]>([]);

  const [to, setTo] = useState<Location | null>(null);
  const [toInput, setToInput] = useState<string>('');
  const [toSuggestions, setToSuggestions] = useState<readonly Location[]>([]);

  const [departureDay, setDepartureDay] = useState<string>('');
  const [departureTime, setDepartureTime] = useState<string>('');
  const [formValid, setFormValid] = useState<boolean>(false);

  // Search options state
  const [showOptions, setShowOptions] = useState(false);
  const [firstClass, setFirstClass] = useState(false);
  const [enabledProducts, setEnabledProducts] = useState<Set<keyof ProductFilter>>(() => new Set(ALL_PRODUCT_KEYS));
  const [maxTransfers, setMaxTransfers] = useState<number>(-1);
  const [bike, setBike] = useState(false);

  // Travel preference state (initialised from profile, overridable per search)
  const [loyaltyCards, setLoyaltyCards] = useState<LoyaltyCardInput[]>(initialLoyaltyCards ?? []);
  const [ageGroup, setAgeGroup] = useState<string>(initialAgeGroup ?? 'ADULT');
  const [deutschlandTicketDiscount, setDeutschlandTicketDiscount] = useState(initialDeutschlandTicketDiscount ?? false);

  // Sync when profile data arrives asynchronously
  useEffect(() => {
    if (initialLoyaltyCards !== undefined) setLoyaltyCards(initialLoyaltyCards);
  }, [initialLoyaltyCards]);
  useEffect(() => {
    if (initialAgeGroup !== undefined) setAgeGroup(initialAgeGroup);
  }, [initialAgeGroup]);
  useEffect(() => {
    if (initialDeutschlandTicketDiscount !== undefined) setDeutschlandTicketDiscount(initialDeutschlandTicketDiscount);
  }, [initialDeutschlandTicketDiscount]);

  const [{ data: fromData, fetching: fromFetching }, reexecuteFromSearchQuery] = useQuery({
    query: LocationSearchQuery,
    variables: {
      query: fromInput.trim(),
    },
    pause: true,
  });
  const getFromSuggestionsDelayed = useCallback(
    debounce(() => {
      reexecuteFromSearchQuery({ requestPolicy: 'network-only' });
    }, 250),
    [reexecuteFromSearchQuery]
  );
  const [{ data: toData, fetching: toFetching }, reexecuteToSearchQuery] = useQuery({
    query: LocationSearchQuery,
    variables: {
      query: toInput.trim(),
    },
    pause: true,
  });
  const getToSuggestionsDelayed = useCallback(
    debounce(() => {
      reexecuteToSearchQuery({ requestPolicy: 'network-only' });
    }, 250),
    [reexecuteToSearchQuery]
  );

  useEffect(() => {
    if (fromInput === '') {
      return undefined;
    }
    setFromSuggestions([]);
    getFromSuggestionsDelayed();
  }, [from, fromInput, getFromSuggestionsDelayed]);

  useEffect(() => {
    if (fromData) {
      setFromSuggestions(dedupLocations(fromData.locations));
    }
  }, [fromData]);

  useEffect(() => {
    if (toInput === '') {
      return undefined;
    }
    setToSuggestions([]);
    getToSuggestionsDelayed();
  }, [to, toInput, getToSuggestionsDelayed]);

  useEffect(() => {
    if (toData) {
      setToSuggestions(dedupLocations(toData.locations));
    }
  }, [toData]);

  function createDateFromDayAndTime(day: string, time: string) {
    const [year, month, date] = day.split('-').map(Number);
    const [hours, minutes] = time.split(':').map(Number);

    return new Date(year, month - 1, date, hours, minutes);
  }

  function createISODateString(day: string, time: string): string {
    return createDateFromDayAndTime(day, time).toISOString();
  }

  const buildSearchOptions = (): JourneySearchOptions | undefined => {
    const opts: JourneySearchOptions = {};

    // Always include travel-preference fields (profile defaults, overridable per search)
    if (loyaltyCards.length > 0) {
      // Strip __typename that urql may have added
      opts.loyaltyCards = loyaltyCards.map((c) => ({ type: c.type, discount: c.discount, class: c.class }));
    }
    if (ageGroup && ageGroup !== 'ADULT') {
      opts.ageGroup = ageGroup;
    }
    if (deutschlandTicketDiscount) {
      opts.deutschlandTicketDiscount = true;
    }

    if (firstClass) {
      opts.firstClass = true;
    }

    // Only include products filter when some (but not all and not zero) modes are selected
    // Send all products with explicit booleans — db-vendo-client's
    // formatProductsFilter uses Object.assign with defaults (all true),
    // so only true values are kept; false values are the only way to
    // exclude a mode.
    const allSelected = enabledProducts.size === ALL_PRODUCT_KEYS.length;
    const noneSelected = enabledProducts.size === 0;
    if (!allSelected && !noneSelected) {
      const products: ProductFilter = {};
      for (const key of ALL_PRODUCT_KEYS) {
        products[key] = enabledProducts.has(key);
      }
      opts.products = products;
    }

    if (maxTransfers >= 0) {
      opts.transfers = maxTransfers;
    }

    if (bike) {
      opts.bike = true;
    }

    return Object.keys(opts).length > 0 ? opts : undefined;
  };

  const handleSearchClick = () => {
    setSearchData({
      departure: from?.name ?? '',
      destination: to?.name ?? '',
      date: departureDay,
      time: departureTime,
    });
    onSearch(
      from?.id ?? '',
      to?.id ?? '',
      createISODateString(departureDay.trim(), departureTime.trim()),
      buildSearchOptions()
    );
  };

  React.useEffect(() => {
    const day = departureDay.trim();
    const time = departureTime.trim();
    setFormValid(
      from?.id !== '' &&
        to?.id !== '' &&
        day !== '' &&
        time !== '' &&
        createDateFromDayAndTime(departureDay, departureTime) > new Date()
    );
  }, [from, to, departureDay, departureTime]);

  const handleProductToggle = (keys: (keyof ProductFilter)[]) => {
    setEnabledProducts((prev) => {
      const next = new Set(prev);
      const allEnabled = keys.every((k) => prev.has(k));
      for (const key of keys) {
        if (allEnabled) {
          next.delete(key);
        } else {
          next.add(key);
        }
      }
      return next;
    });
  };

  const handleEnableAllProducts = () => {
    setEnabledProducts(new Set(ALL_PRODUCT_KEYS));
  };

  const handleClearAllProducts = () => {
    setEnabledProducts(new Set());
  };

  const handleTransfersChange = (e: SelectChangeEvent<number>) => {
    setMaxTransfers(Number(e.target.value));
  };

  // Loyalty card handlers
  const usedCardKeys = new Set(loyaltyCards.map(cardToKey));
  const canAddMoreCards = LOYALTY_CARD_OPTIONS.some((opt) => !usedCardKeys.has(opt.key));
  const [addCardAnchor, setAddCardAnchor] = useState<null | HTMLElement>(null);

  const handleOpenAddCard = (event: React.MouseEvent<HTMLElement>) => {
    setAddCardAnchor(event.currentTarget);
  };

  const handleCloseAddCard = () => {
    setAddCardAnchor(null);
  };

  const handleSelectCard = (key: string) => {
    const card = keyToCard(key);
    if (card) {
      setLoyaltyCards([...loyaltyCards, card]);
    }
    setAddCardAnchor(null);
  };

  const handleRemoveCard = (index: number) => {
    setLoyaltyCards(loyaltyCards.filter((_, i) => i !== index));
  };

  const handleAgeGroupChange = (e: SelectChangeEvent) => {
    setAgeGroup(e.target.value);
  };

  const handleDTicketToggle = (_event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
    setDeutschlandTicketDiscount(checked);
  };

  const optionsActive =
    firstClass ||
    enabledProducts.size < ALL_PRODUCT_KEYS.length ||
    maxTransfers >= 0 ||
    bike ||
    loyaltyCards.length > 0 ||
    deutschlandTicketDiscount ||
    ageGroup !== 'ADULT';

  const cardSx = { border: 1, borderColor: 'divider', borderRadius: 3, p: 2.75 };
  const sectionTitleSx = {
    fontSize: 11,
    fontWeight: 700,
    color: 'text.secondary',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.07em',
    mb: 2,
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.75 }}>
      {/* Card 1: Search fields */}
      <Paper elevation={0} sx={cardSx}>
        <Grid container spacing={1.75} sx={{ mb: 1.75 }}>
          <Grid size={{ xs: 12, sm: 6 }}>
            <Typography variant="fieldLabel" sx={fieldLabelSx}>
              From
            </Typography>
            <Autocomplete
              id="departure"
              value={from}
              options={fromSuggestions ?? []}
              filterOptions={(x) => x}
              getOptionLabel={(option) => option?.name ?? ''}
              includeInputInList
              filterSelectedOptions
              noOptionsText="No locations found"
              loading={fromFetching}
              size="small"
              renderInput={(params) => (
                <TextField
                  {...params}
                  placeholder="Station"
                  fullWidth
                  inputProps={{
                    ...params.inputProps,
                    'aria-label': 'From station',
                  }}
                  slotProps={{
                    input: {
                      ...params.InputProps,
                      startAdornment: (
                        <>
                          <InputAdornment position="start">
                            <LocationOnIcon sx={{ fontSize: 18, color: 'text.disabled' }} />
                          </InputAdornment>
                          {params.InputProps.startAdornment}
                        </>
                      ),
                    },
                  }}
                />
              )}
              isOptionEqualToValue={(option: Location, value: Location) => option?.id === value?.id}
              getOptionKey={(option: Location) => option.id}
              onChange={(_event: React.SyntheticEvent, newValue: Location | null) => {
                setFromSuggestions(
                  newValue
                    ? dedupLocations([newValue, ...(fromSuggestions ?? [])])
                    : dedupLocations(fromSuggestions ?? [])
                );
                setFrom(newValue);
              }}
              onInputChange={(_event, newInputValue) => {
                setFromInput(newInputValue);
              }}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <Typography variant="fieldLabel" sx={fieldLabelSx}>
              To
            </Typography>
            <Autocomplete
              id="arrival"
              value={to}
              options={toSuggestions ?? []}
              filterOptions={(x) => x}
              getOptionLabel={(option) => option?.name ?? ''}
              includeInputInList
              filterSelectedOptions
              noOptionsText="No locations found"
              loading={toFetching}
              size="small"
              renderInput={(params) => (
                <TextField
                  {...params}
                  placeholder="Station"
                  fullWidth
                  inputProps={{
                    ...params.inputProps,
                    'aria-label': 'To station',
                  }}
                  slotProps={{
                    input: {
                      ...params.InputProps,
                      startAdornment: (
                        <>
                          <InputAdornment position="start">
                            <LocationOnIcon sx={{ fontSize: 18, color: 'text.disabled' }} />
                          </InputAdornment>
                          {params.InputProps.startAdornment}
                        </>
                      ),
                    },
                  }}
                />
              )}
              isOptionEqualToValue={(option: Location, value: Location) => option?.id === value?.id}
              getOptionKey={(option: Location) => option.id}
              onChange={(_event: React.SyntheticEvent, newValue: Location | null) => {
                setToSuggestions(
                  newValue ? dedupLocations([newValue, ...(toSuggestions ?? [])]) : dedupLocations(toSuggestions ?? [])
                );
                setTo(newValue);
              }}
              onInputChange={(_event, newInputValue) => {
                setToInput(newInputValue);
              }}
            />
          </Grid>
        </Grid>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
            gap: 1.5,
            alignItems: 'end',
          }}
        >
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 1.5 }}>
            <Box>
              <Typography variant="fieldLabel" sx={fieldLabelSx}>
                Departure date
              </Typography>
              <TextField
                id="date"
                type="date"
                value={departureDay}
                onChange={(e) => setDepartureDay(e.target.value)}
                fullWidth
                size="small"
                slotProps={{
                  htmlInput: { 'aria-label': 'Departure date' },
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        <CalendarTodayIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
                      </InputAdornment>
                    ),
                  },
                }}
              />
            </Box>
            <Box>
              <Typography variant="fieldLabel" sx={fieldLabelSx}>
                Time
              </Typography>
              <TextField
                id="time"
                type="time"
                value={departureTime}
                onChange={(e) => setDepartureTime(e.target.value)}
                fullWidth
                slotProps={{
                  htmlInput: { 'aria-label': 'Departure time' },
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        <AccessTimeIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
                      </InputAdornment>
                    ),
                  },
                }}
                size="small"
              />
            </Box>
          </Box>
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 1.5, alignItems: 'end' }}>
            <Box>
              <Typography variant="fieldLabel" sx={fieldLabelSx}>
                Age group
              </Typography>
              <FormControl size="small" fullWidth>
                <Select
                  value={ageGroup}
                  onChange={handleAgeGroupChange}
                  sx={{ fontSize: 13 }}
                  startAdornment={
                    <InputAdornment position="start">
                      <PersonIcon sx={{ fontSize: 18, color: 'text.disabled' }} />
                    </InputAdornment>
                  }
                >
                  {AGE_GROUP_OPTIONS.map((opt) => (
                    <MenuItem key={opt.value} value={opt.value} sx={{ fontSize: 13 }}>
                      {opt.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Box>
            <Button
              variant="contained"
              disabled={!formValid}
              onClick={handleSearchClick}
              startIcon={<SearchIcon sx={{ fontSize: '16px !important' }} />}
              sx={{ textTransform: 'none', fontWeight: 600, height: 40, whiteSpace: 'nowrap' }}
            >
              Search
            </Button>
          </Box>
        </Box>
      </Paper>

      {/* Options toggle */}
      <Box sx={{ mt: -1.5 }}>
        <Button
          size="small"
          startIcon={<TuneIcon sx={{ fontSize: '14px !important' }} />}
          onClick={() => setShowOptions((prev) => !prev)}
          sx={{
            fontSize: 12,
            textTransform: 'none',
            color: optionsActive ? 'primary.main' : 'text.secondary',
            fontWeight: optionsActive ? 600 : 400,
          }}
        >
          {showOptions ? 'Hide options' : 'Search options'}
          {optionsActive && !showOptions && (
            <Chip label="active" size="small" color="primary" sx={{ ml: 0.75, height: 18, fontSize: 10 }} />
          )}
        </Button>
      </Box>

      <Collapse in={showOptions}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.75 }}>
          {/* Card 2: Journey Preferences + Transport Modes (side-by-side) */}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
              gap: 2.75,
            }}
          >
            {/* Journey Preferences */}
            <Paper elevation={0} sx={cardSx}>
              <Typography sx={sectionTitleSx}>Journey Preferences</Typography>

              <Box sx={{ mb: 2 }}>
                <Typography variant="fieldLabel" sx={{ display: 'block', mb: 1 }}>
                  Travel class
                </Typography>
                <ToggleButtonGroup
                  value={firstClass ? '1' : '2'}
                  exclusive
                  onChange={(_e, val) => {
                    if (val !== null) setFirstClass(val === '1');
                  }}
                  size="small"
                >
                  <ToggleButton value="2" sx={{ fontSize: 12, textTransform: 'none', px: 2 }}>
                    2nd class
                  </ToggleButton>
                  <ToggleButton value="1" sx={{ fontSize: 12, textTransform: 'none', px: 2 }}>
                    1st class
                  </ToggleButton>
                </ToggleButtonGroup>
              </Box>

              <Box sx={{ mb: 2 }}>
                <Typography variant="fieldLabel" sx={fieldLabelSx}>
                  Max transfers
                </Typography>
                <FormControl size="small" fullWidth>
                  <Select value={maxTransfers} onChange={handleTransfersChange} sx={{ fontSize: 13 }}>
                    {TRANSFER_OPTIONS.map((opt) => (
                      <MenuItem key={opt.value} value={opt.value} sx={{ fontSize: 13 }}>
                        {opt.label}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Box>

              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <BikeIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
                <Typography sx={{ fontSize: 13, fontWeight: 500, color: 'text.primary', flex: 1 }}>
                  Bicycle space
                </Typography>
                <Switch checked={bike} onChange={(_e, checked) => setBike(checked)} color="secondary" size="small" />
              </Box>
            </Paper>

            {/* Transport Modes */}
            <Paper elevation={0} sx={cardSx}>
              <Typography sx={sectionTitleSx}>Transport Modes</Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                <Chip
                  label="All"
                  size="small"
                  variant={enabledProducts.size === ALL_PRODUCT_KEYS.length ? 'filled' : 'outlined'}
                  color={enabledProducts.size === ALL_PRODUCT_KEYS.length ? 'primary' : 'default'}
                  onClick={handleEnableAllProducts}
                  sx={{ fontSize: 12, cursor: 'pointer' }}
                />
                <Chip
                  label="None"
                  size="small"
                  variant={enabledProducts.size === 0 ? 'filled' : 'outlined'}
                  color={enabledProducts.size === 0 ? 'primary' : 'default'}
                  onClick={handleClearAllProducts}
                  sx={{ fontSize: 12, cursor: 'pointer' }}
                />
                {PRODUCT_TOGGLES.map((p) => (
                  <Chip
                    key={p.keys.join(',')}
                    label={p.label}
                    size="small"
                    variant={p.keys.every((k) => enabledProducts.has(k)) ? 'filled' : 'outlined'}
                    color={p.keys.every((k) => enabledProducts.has(k)) ? 'primary' : 'default'}
                    onClick={() => handleProductToggle(p.keys)}
                    sx={{ fontSize: 12, cursor: 'pointer' }}
                  />
                ))}
              </Box>
            </Paper>
          </Box>

          {/* Card 3: Discounts & Pricing */}
          <Paper elevation={0} sx={cardSx}>
            <Typography sx={sectionTitleSx}>Discounts &amp; Pricing</Typography>

            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
              {loyaltyCards.map((card, index) => (
                <Chip
                  key={index}
                  label={cardLabel(card)}
                  size="small"
                  variant="outlined"
                  onDelete={() => handleRemoveCard(index)}
                  sx={{ fontSize: 12 }}
                />
              ))}
              {canAddMoreCards && (
                <>
                  <Chip
                    label="Add card"
                    size="small"
                    variant="outlined"
                    icon={<AddIcon sx={{ fontSize: '16px !important' }} />}
                    onClick={handleOpenAddCard}
                    sx={{ fontSize: 12, cursor: 'pointer' }}
                  />
                  <Menu
                    anchorEl={addCardAnchor}
                    open={Boolean(addCardAnchor)}
                    onClose={handleCloseAddCard}
                    slotProps={{ paper: { sx: { maxHeight: 300 } } }}
                  >
                    {LOYALTY_CARD_OPTIONS.filter((opt) => !usedCardKeys.has(opt.key)).map((opt) => (
                      <MenuItem key={opt.key} onClick={() => handleSelectCard(opt.key)} sx={{ fontSize: 13 }}>
                        {opt.label}
                      </MenuItem>
                    ))}
                  </Menu>
                </>
              )}
            </Box>

            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                pt: 1.5,
                borderTop: 1,
                borderColor: 'divider',
              }}
            >
              <Box>
                <Typography sx={{ fontSize: 13, fontWeight: 600, color: 'text.primary' }}>Deutschlandticket</Typography>
                <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
                  Regional costs deducted from prices
                </Typography>
              </Box>
              <Switch
                checked={deutschlandTicketDiscount}
                onChange={handleDTicketToggle}
                color="secondary"
                size="small"
              />
            </Box>
          </Paper>
        </Box>
      </Collapse>
    </Box>
  );
};

export default SearchMask;
