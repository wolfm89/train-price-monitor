import { createTheme } from '@mui/material/styles';

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
      main: '#A82323',
    },
    warning: {
      main: '#ddc040',
    },
    background: {
      default: '#f8f8f4',
      paper: '#ffffff',
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
  },
  shape: {
    borderRadius: 8,
  },
});
