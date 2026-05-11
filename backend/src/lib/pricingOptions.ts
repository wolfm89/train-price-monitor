import Logger from './logger';
import { LoyaltyCardData } from './loyaltyCards';
import { PricingOptions } from '../managers/DbHafasManager';

export function loadStoredPricingOptions(dbJourney: {
  firstClass?: boolean;
  bike?: boolean;
  loyaltyCard?: string;
  ageGroup?: string;
  deutschlandTicketDiscount?: boolean;
}): PricingOptions | undefined {
  const opts: PricingOptions = {};

  if (dbJourney.firstClass !== undefined) {
    opts.firstClass = dbJourney.firstClass;
  }

  if (dbJourney.bike !== undefined) {
    opts.bike = dbJourney.bike;
  }

  if (dbJourney.loyaltyCard) {
    try {
      // Migration shim: handle old array format by taking the first element
      const parsed = JSON.parse(dbJourney.loyaltyCard) as LoyaltyCardData | LoyaltyCardData[];
      opts.loyaltyCard = Array.isArray(parsed) ? parsed[0] : parsed;
    } catch {
      Logger.warn('Failed to parse stored loyaltyCard JSON for pricing', { raw: dbJourney.loyaltyCard });
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
