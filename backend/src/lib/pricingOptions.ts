import Logger from './logger';
import { LoyaltyCardData } from './loyaltyCards';
import { PricingOptions } from '../managers/DbHafasManager';

export function loadStoredPricingOptions(dbJourney: {
  firstClass?: boolean;
  loyaltyCards?: string;
  ageGroup?: string;
  deutschlandTicketDiscount?: boolean;
}): PricingOptions | undefined {
  const opts: PricingOptions = {};

  if (dbJourney.firstClass !== undefined) {
    opts.firstClass = dbJourney.firstClass;
  }

  if (dbJourney.loyaltyCards) {
    try {
      opts.loyaltyCards = JSON.parse(dbJourney.loyaltyCards) as LoyaltyCardData[];
    } catch {
      Logger.warn('Failed to parse stored loyaltyCards JSON for pricing', { raw: dbJourney.loyaltyCards });
    }
  }

  if (dbJourney.ageGroup) {
    opts.ageGroup = dbJourney.ageGroup;
  }

  if (dbJourney.deutschlandTicketDiscount !== undefined) {
    opts.deutschlandTicketDiscount = dbJourney.deutschlandTicketDiscount;
  }

  return Object.keys(opts).length > 0 ? opts : undefined;
}
