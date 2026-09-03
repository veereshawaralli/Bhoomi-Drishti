/** @type {import('tailwindcss').Config} */
// Design tokens for the "night operations" control-room theme.
// Palette is built from geotechnical vernacular: cold slate rock for the
// chrome, and a soil/rock severity ramp (teal water -> lichen -> ochre ->
// laterite -> magma) that stays monotonic in lightness so severity is still
// readable at a glance and for colour-vision-deficient viewers.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ground: '#08121C',
        panel: '#0D1B29',
        raised: '#112436',
        hairline: '#1C3346',
        hairbright: '#2A4A63',
        ink: '#DCE7F0',
        dim: '#8AA2B8',
        faint: '#5C7691',
        accent: '#48C9E6',
        accentdim: '#1E7A94',
        risk: {
          verylow: '#3FB8A0',
          low: '#A8C256',
          moderate: '#E8B23A',
          high: '#E2683C',
          critical: '#C81E4E',
        },
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'Verdana', 'system-ui', 'sans-serif'],
        sans: ['"IBM Plex Sans"', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.04em' }],
        readout: ['2.75rem', { lineHeight: '1', letterSpacing: '-0.03em' }],
      },
      borderRadius: { panel: '3px' },
      boxShadow: {
        bezel: 'inset 0 1px 0 0 rgba(255,255,255,0.04)',
        glow: '0 0 0 1px rgba(72,201,230,0.35), 0 0 24px -6px rgba(72,201,230,0.4)',
        danger: '0 0 0 1px rgba(200,30,78,0.45), 0 0 30px -8px rgba(200,30,78,0.55)',
      },
      keyframes: {
        pulsering: {
          '0%': { transform: 'scale(0.6)', opacity: '0.85' },
          '100%': { transform: 'scale(2.4)', opacity: '0' },
        },
        sweep: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(320%)' },
        },
        blip: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.25' } },
        rise: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        pulsering: 'pulsering 2.4s cubic-bezier(0.2,0.6,0.3,1) infinite',
        sweep: 'sweep 2.2s linear infinite',
        blip: 'blip 1.6s ease-in-out infinite',
        rise: 'rise 0.28s ease-out both',
      },
    },
  },
  plugins: [],
};
