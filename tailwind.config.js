/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0b0f1a',
        surface: '#131826',
        surfaceAlt: '#1b2233',
        border: '#232b3d',
        accent: '#f5a623',
        text: '#e7ebf3',
        textMuted: '#8b93a7',
        danger: '#e2607a',
        success: '#4fb286'
      }
    }
  },
  plugins: []
}
