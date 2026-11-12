import { describe, expect, it } from 'vitest';
import { FAQ_ITEMS, buildFaqJsonLd } from './faq';

describe('FAQ content and schema', () => {
  it('has enough visible questions for a useful FAQ', () => {
    expect(FAQ_ITEMS.length).toBeGreaterThanOrEqual(4);
  });

  it('gives every question a non-empty answer', () => {
    for (const item of FAQ_ITEMS) {
      expect(item.question.trim()).not.toBe('');
      expect(item.answer.trim()).not.toBe('');
    }
  });

  it('builds a FAQPage whose questions and answers match the visible copy', () => {
    const schema = buildFaqJsonLd();

    expect(schema['@context']).toBe('https://schema.org');
    expect(schema['@type']).toBe('FAQPage');
    expect(schema.mainEntity).toHaveLength(FAQ_ITEMS.length);
    expect(schema.mainEntity.map((entry) => entry.name)).toEqual(FAQ_ITEMS.map((item) => item.question));
    expect(schema.mainEntity.map((entry) => entry.acceptedAnswer.text)).toEqual(FAQ_ITEMS.map((item) => item.answer));
  });
});
