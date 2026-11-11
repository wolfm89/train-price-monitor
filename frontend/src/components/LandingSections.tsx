import React from 'react';
import { Box, Grid, Link, Paper, Typography } from '@mui/material';
import { CheckCircleOutline, ExpandMore } from '@mui/icons-material';
import { FAQ_ITEMS, buildFaqJsonLd } from '../content/faq';
import { LEGAL_NOTICE_URL, PRIVACY_POLICY_URL } from '../utils/legalLinks';

const bodySx = {
  fontSize: 13,
  color: 'text.secondary',
  lineHeight: 1.7,
};

const sectionLinkSx = {
  fontSize: 12,
  color: 'primary.main',
  textDecoration: 'underline',
  textUnderlineOffset: '2px',
  '&:hover': { color: 'primary.dark' },
};

const STEPS = [
  {
    title: 'Search your connection',
    body: 'Enter your stations, travel date and time, then search Deutsche Bahn connections.',
  },
  {
    title: 'Set your price limit',
    body: 'Pick the connection and enter the highest fare you are willing to pay.',
  },
  {
    title: 'Get alerted',
    body: 'We check the fare every hour and alert you in-app and by email when it rises above your limit.',
  },
];

const TRUST_ITEMS = ['Free to use', 'No ads', 'No tracking or analytics', 'No cookies', 'Export or delete your data'];

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <Typography id={`${id}-heading`} variant="h5" component="h2" sx={{ mb: 1 }}>
      {children}
    </Typography>
  );
}

function Section({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <Box id={id} component="section" aria-labelledby={`${id}-heading`} sx={{ width: '100%', mt: 5 }}>
      {children}
    </Box>
  );
}

function FaqJsonLd() {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(buildFaqJsonLd()) }} />;
}

export default function LandingSections() {
  return (
    <>
      <Section id="how-it-works">
        <SectionHeading id="how-it-works">How it works</SectionHeading>
        <Grid container spacing={1.25}>
          {STEPS.map((step, index) => (
            <Grid size={{ xs: 12, sm: 4 }} key={step.title}>
              <Paper
                elevation={0}
                sx={{
                  p: 2.25,
                  height: '100%',
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 2,
                  bgcolor: 'background.paper',
                  display: 'flex',
                  gap: 1.5,
                }}
              >
                <Box
                  sx={{
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    bgcolor: 'secondary.light',
                    color: 'secondary.dark',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 13,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {index + 1}
                </Box>
                <Box>
                  <Typography component="h3" sx={{ fontSize: 14, fontWeight: 600, mb: 0.5 }}>
                    {step.title}
                  </Typography>
                  <Typography sx={bodySx}>{step.body}</Typography>
                </Box>
              </Paper>
            </Grid>
          ))}
        </Grid>
      </Section>

      <Section id="free-and-private">
        <SectionHeading id="free-and-private">Free and private</SectionHeading>
        <Paper elevation={0} sx={{ p: { xs: 2, sm: 2.5 }, border: 1, borderColor: 'divider', borderRadius: 2 }}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: { xs: 1.25, sm: 2 } }}>
            {TRUST_ITEMS.map((item) => (
              <Box key={item} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <CheckCircleOutline sx={{ fontSize: 16, color: 'secondary.dark', flexShrink: 0 }} />
                <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>{item}</Typography>
              </Box>
            ))}
          </Box>
          <Typography sx={{ ...bodySx, mt: 1.5 }}>
            See the{' '}
            <Link href={PRIVACY_POLICY_URL} sx={sectionLinkSx}>
              privacy policy
            </Link>{' '}
            for details, including the providers involved, and the{' '}
            <Link href={LEGAL_NOTICE_URL} sx={sectionLinkSx}>
              legal notice
            </Link>
            .
          </Typography>
        </Paper>
      </Section>

      <Section id="faq">
        <SectionHeading id="faq">Frequently asked questions</SectionHeading>
        <Typography sx={{ ...bodySx, mb: 1.5 }}>
          Short answers to the questions people ask before they start monitoring fares.
        </Typography>
        <Box
          sx={{
            border: 1,
            borderColor: 'divider',
            borderRadius: 2,
            bgcolor: 'background.paper',
            overflow: 'hidden',
          }}
        >
          {FAQ_ITEMS.map((item, index) => (
            <Box
              component="details"
              key={item.question}
              sx={{
                borderTop: index === 0 ? 0 : 1,
                borderColor: 'divider',
                '&[open] .faq-chevron': { transform: 'rotate(180deg)' },
              }}
            >
              <Box
                component="summary"
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 1,
                  p: 2.25,
                  cursor: 'pointer',
                  listStyle: 'none',
                  '&::-webkit-details-marker': { display: 'none' },
                  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: '-2px' },
                }}
              >
                <Typography component="h3" sx={{ fontSize: 14, fontWeight: 600 }}>
                  {item.question}
                </Typography>
                <ExpandMore className="faq-chevron" sx={{ fontSize: 20, color: 'text.secondary', flexShrink: 0 }} />
              </Box>
              <Typography sx={{ ...bodySx, px: 2.25, pb: 2.25 }}>{item.answer}</Typography>
            </Box>
          ))}
        </Box>
        <FaqJsonLd />
      </Section>
    </>
  );
}
