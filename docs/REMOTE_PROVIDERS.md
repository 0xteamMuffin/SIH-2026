# Optional remote inference providers

Remote providers are development fallbacks for public or synthetic data. They are automatically excluded when their required environment variables are absent, and every remote profile is disabled in sovereign mode.

Never commit API keys or paste them into issues, logs, or chat messages. Store them only in the ignored root `.env` file.

## OpenRouter

- Sign up: https://openrouter.ai/
- Create a key: https://openrouter.ai/settings/keys
- Environment variable: `REMOTE_MODEL_API_KEY`

## GroqCloud

- Sign up: https://console.groq.com/
- Create a key: https://console.groq.com/keys
- Limits: https://console.groq.com/docs/rate-limits
- Environment variable: `GROQ_API_KEY`

## Google AI Studio

- Open AI Studio: https://aistudio.google.com/
- Create a key: https://aistudio.google.com/app/apikey
- Limits: https://ai.google.dev/gemini-api/docs/rate-limits
- Environment variable: `GEMINI_API_KEY`

## Mistral Studio

- Sign up: https://console.mistral.ai/
- API setup: https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key
- Environment variable: `MISTRAL_API_KEY`

## Cloudflare Workers AI

- Sign up: https://dash.cloudflare.com/sign-up/workers-and-pages
- Create an API token: https://dash.cloudflare.com/profile/api-tokens
- Find the account ID in the Workers AI dashboard.
- REST setup: https://developers.cloudflare.com/workers-ai/get-started/rest-api/
- Environment variables: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_AI_BASE_URL`

The Cloudflare base URL has this form:

```text
https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1
```

## Local environment template

```dotenv
ALLOW_REMOTE_INFERENCE=true
REMOTE_MODEL_API_KEY=
GROQ_API_KEY=
GEMINI_API_KEY=
MISTRAL_API_KEY=
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_AI_BASE_URL=
```

Populate only the providers you intend to use. Restart the worker after adding or rotating a key.
