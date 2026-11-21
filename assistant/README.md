# JobRadar application assistant

JobRadar can make a German application draft from four multiple-choice answers. Drafts from the built-in template work without an account. The optional Worker uses the OpenAI Responses API for AI-generated drafts.

## Deploy the Worker

From this directory, log in to Cloudflare and set the two Worker secrets before deploying. Use an OpenAI project API key and a separate random access code of at least 24 characters.

```sh
npx wrangler login
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ASSISTANT_CODE
npx wrangler deploy
```

In JobRadar, open Settings, expand **KI-Assistent verbinden**, and enter the deployed HTTPS URL ending in `/draft` and the separate access code. Open **Assistent** on a business card and choose **KI-Entwurf erstellen** after answering the four questions.

The Worker accepts the company name, industry and four answer codes. JobRadar adds the greeting and the applicant name locally. **In Mail öffnen** opens an editable draft in the phone’s mail app. The Worker limits draft requests and sets `store: false` on OpenAI requests.
