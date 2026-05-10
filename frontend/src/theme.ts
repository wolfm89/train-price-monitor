import { createTheme } from '@mui/material/styles';

declare module '@mui/material/styles' {
  interface TypeBackground {
    ticket: string;
  }
  interface TypographyVariants {
    sectionTitle: React.CSSProperties;
    fieldLabel: React.CSSProperties;
  }
  interface TypographyVariantsOptions {
    sectionTitle?: React.CSSProperties;
    fieldLabel?: React.CSSProperties;
  }
}

declare module '@mui/material/Typography' {
  interface TypographyPropsVariantOverrides {
    sectionTitle: true;
    fieldLabel: true;
  }
}

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#A82323',
      dark: '#7a1818',
    },
    secondary: {
      main: '#6D9E51',
      light: '#BCD9A2',
      dark: '#4e7539',
    },
    success: {
      main: '#2d7a3a',
    },
    error: {
      main: '#c62828',
    },
    warning: {
      main: '#FEFFD3',
    },
    info: {
      main: '#5b7a9e',
    },
    background: {
      default: '#f8f8f4',
      paper: '#ffffff',
      ticket: '#eeeeee',
    },
    text: {
      primary: '#1a1a16',
      secondary: '#787870',
      disabled: '#a0a090',
    },
    divider: '#e2e2d8',
  },
  typography: {
    fontFamily: '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif',
    h1: {
      fontSize: 30,
      fontWeight: 700,
      letterSpacing: '-0.025em',
      lineHeight: 1.2,
    },
    h5: {
      fontSize: 20,
      fontWeight: 700,
      letterSpacing: '-0.02em',
    },
    body2: {
      fontSize: 13,
    },
    overline: {
      fontSize: 12,
      fontWeight: 700,
      letterSpacing: '0.07em',
      textTransform: 'uppercase',
      lineHeight: 1.6,
      color: '#787870',
    },
    sectionTitle: {
      fontSize: 12,
      fontWeight: 700,
      letterSpacing: '0.07em',
      textTransform: 'uppercase',
      color: '#787870',
    },
    fieldLabel: {
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      color: '#787870',
    },
  },
  shape: {
    borderRadius: 8,
  },
});
