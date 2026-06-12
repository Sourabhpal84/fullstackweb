import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#08111f",
        brand: "#ff7b00",
        mint: "#22c55e"
      },
      boxShadow: {
        glow: "0 24px 80px rgba(0,0,0,.22)"
      }
    }
  },
  plugins: []
};

export default config;
