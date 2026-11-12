export interface FaqItem {
  question: string;
  answer: string;
}

/**
 * Public FAQ. The same strings are rendered on the landing page and used for
 * the FAQPage JSON-LD, so the structured data cannot drift from the copy.
 */
export const FAQ_ITEMS: FaqItem[] = [
  {
    question: 'How often are prices checked?',
    answer:
      'Every monitored journey is checked once an hour in the background. You do not need to keep the page open for the check to run.',
  },
  {
    question: 'How will I be notified?',
    answer:
      'You receive an in-app notification in the bell menu and an email by default. Email notifications can be turned off in your profile.',
  },
  {
    question: 'Which journeys can I monitor?',
    answer:
      'Connections that show a fare and a Watch button in the search results, including ICE, IC and regional services. The search filters let you choose train types, class, number of transfers, bike carriage and Deutschland-Ticket options.',
  },
  {
    question: 'Does Train Price Monitor book tickets?',
    answer:
      'No. It only watches prices and sends alerts. When the fare is right, you book directly with Deutsche Bahn.',
  },
  {
    question: 'What happens to my data?',
    answer:
      'Your account stores the journeys you monitor, your limits and your notifications. You can export or delete your data from your profile. The privacy policy explains the providers involved.',
  },
];

export interface FaqQuestionSchema {
  '@type': 'Question';
  name: string;
  acceptedAnswer: {
    '@type': 'Answer';
    text: string;
  };
}

export interface FaqPageSchema {
  '@context': 'https://schema.org';
  '@type': 'FAQPage';
  mainEntity: FaqQuestionSchema[];
}

export function buildFaqJsonLd(): FaqPageSchema {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ_ITEMS.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  };
}
