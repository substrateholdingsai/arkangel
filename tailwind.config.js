import arkangel from './design-system/tailwind.preset.js';

/** @type {import('tailwindcss').Config} */
export default {
  presets: [arkangel],
  content: [
    './frontend/index.html',
    './frontend/src/**/*.{ts,tsx}',
    './design-system/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
