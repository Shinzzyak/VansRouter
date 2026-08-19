/**
 * Bitdeer AI — GPU cloud platform with referral program.
 *
 * Website: https://www.bitdeer.ai
 * Account: https://account.bitdeer.com
 * Signup: POST /api/v1/auth/signup (email, password, referral_id)
 * Anti-bot: Geetest v4 (gt4.js, gcaptcha4.js slider captcha)
 *
 * Referral chain strategy:
 * 1. Register root account with master referral ID
 * 2. Extract new account's referralCode
 * 3. Feed to child registrations (chain or fan-out)
 */

const bitdeerRegistry = {
  id: "bitdeer",
  priority: 50,
  hasFree: true,
  alias: "bd",
  uiAlias: "bd",
  display: {
    name: "Bitdeer",
    icon: "cloud",
    color: "#49B881",
    textIcon: "BD",
    website: "https://www.bitdeer.ai",
    notice: {
      signupUrl: "https://account.bitdeer.com/en/sign_up?method=1&service=https://www.bitdeer.ai/auth",
      text: "GPU cloud platform with referral program. Referral chain: register → extract referralCode → use for children.",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://www.bitdeer.ai/api/v1",
    format: "openai",
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    },
    retry: {
      429: { attempts: 3, delayMs: 3000 },
      500: { attempts: 3, delayMs: 2000 },
    },
  },
  models: [
    { id: "bitdeer/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "bitdeer/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "bitdeer/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  ],
};

export default bitdeerRegistry;
