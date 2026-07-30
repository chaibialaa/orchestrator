/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#0a0b0d',
          900: '#111318',
          850: '#161920',
          800: '#1c2029',
          700: '#272c38',
          600: '#3a4152',
          400: '#7c869c',
          300: '#a3adc2',
          100: '#e6e9f0',
        },
        proof: '#3fb950',
        halt: '#f0883e',
        fail: '#f85149',
        run: '#58a6ff',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
}
