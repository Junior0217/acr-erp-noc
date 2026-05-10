/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        acr: {
          dark: '#0f172a',    // Gris Pizarra profundo
          blue: '#2563eb',    // Azul Eléctrico
          accent: '#06b6d4',  // Cian para indicadores técnicos
        }
      }
    },
  },
  plugins: [],
}