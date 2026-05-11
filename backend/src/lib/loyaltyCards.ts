import { data as loyaltyCardSymbols } from 'db-vendo-client/format/loyalty-cards.js';

export interface LoyaltyCardData {
  type: string;
  discount?: number;
  class?: number;
}

interface HafasLoyaltyCard {
  type: symbol;
  discount?: number;
  class?: number;
}

const LOYALTY_CARD_MAP: Record<string, symbol> = {
  BAHNCARD: loyaltyCardSymbols.BAHNCARD,
  VORTEILSCARD: loyaltyCardSymbols.VORTEILSCARD,
  HALBTAXABO: loyaltyCardSymbols.HALBTAXABO,
  VOORDEELURENABO: loyaltyCardSymbols.VOORDEELURENABO,
  SHCARD: loyaltyCardSymbols.SHCARD,
  GENERALABONNEMENT: loyaltyCardSymbols.GENERALABONNEMENT,
  NL_40: loyaltyCardSymbols.NL_40,
  AT_KLIMATICKET: loyaltyCardSymbols.AT_KLIMATICKET,
};

export const VALID_LOYALTY_CARD_TYPES = Object.keys(LOYALTY_CARD_MAP);

export function toHafasLoyaltyCard(input: LoyaltyCardData): HafasLoyaltyCard {
  const symbol = LOYALTY_CARD_MAP[input.type];
  if (!symbol) {
    throw new Error(`Unknown loyalty card type: ${input.type}`);
  }
  return {
    type: symbol,
    discount: input.discount,
    class: input.class,
  };
}

export function validateLoyaltyCard(card: LoyaltyCardData): void {
  if (!VALID_LOYALTY_CARD_TYPES.includes(card.type)) {
    throw new Error(`Invalid loyalty card type: ${card.type}. Valid types: ${VALID_LOYALTY_CARD_TYPES.join(', ')}`);
  }

  if (card.type === 'BAHNCARD') {
    if (card.discount !== 25 && card.discount !== 50) {
      throw new Error('Bahncard discount must be 25 or 50');
    }
    if (card.class !== 1 && card.class !== 2) {
      throw new Error('Bahncard class must be 1 or 2');
    }
  }

  if (card.type === 'GENERALABONNEMENT') {
    if (card.class !== 1 && card.class !== 2) {
      throw new Error('General-Abonnement class must be 1 or 2');
    }
  }
}

const AGE_GROUP_MAP: Record<string, string> = {
  BABY: 'B',
  CHILD: 'K',
  YOUTH: 'Y',
  ADULT: 'E',
  SENIOR: 'S',
};

export const VALID_AGE_GROUPS = Object.keys(AGE_GROUP_MAP);

export function toHafasAgeGroup(ageGroup: string): string {
  const mapped = AGE_GROUP_MAP[ageGroup];
  if (!mapped) {
    throw new Error(`Invalid age group: ${ageGroup}. Valid values: ${VALID_AGE_GROUPS.join(', ')}`);
  }
  return mapped;
}
