// Shared types, constants, and helpers for travel preferences
// Used by both TravelPreferences (profile page) and SearchMask (search page)

export interface LoyaltyCardInput {
  type: string;
  discount?: number | null;
  class?: number | null;
}

export const AGE_GROUP_OPTIONS = [
  { value: 'BABY', label: 'Baby (0-5)' },
  { value: 'CHILD', label: 'Child (6-14)' },
  { value: 'YOUTH', label: 'Youth (15-26)' },
  { value: 'ADULT', label: 'Adult' },
  { value: 'SENIOR', label: 'Senior (65+)' },
] as const;

export interface LoyaltyCardOption {
  key: string;
  label: string;
  card: LoyaltyCardInput;
}

export const LOYALTY_CARD_OPTIONS: LoyaltyCardOption[] = [
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

export function cardToKey(card: LoyaltyCardInput): string {
  const match = LOYALTY_CARD_OPTIONS.find(
    (opt) =>
      opt.card.type === card.type &&
      (opt.card.discount ?? null) === (card.discount ?? null) &&
      (opt.card.class ?? null) === (card.class ?? null)
  );
  return match?.key ?? '';
}

export function keyToCard(key: string): LoyaltyCardInput | undefined {
  return LOYALTY_CARD_OPTIONS.find((opt) => opt.key === key)?.card;
}

export function cardLabel(card: LoyaltyCardInput): string {
  const match = LOYALTY_CARD_OPTIONS.find(
    (opt) =>
      opt.card.type === card.type &&
      (opt.card.discount ?? null) === (card.discount ?? null) &&
      (opt.card.class ?? null) === (card.class ?? null)
  );
  return match?.label ?? card.type;
}
