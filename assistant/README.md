# JobRadar application assistant

JobRadar can make a German application draft from four multiple-choice answers. Drafts from the built-in template work without an account. The optional Worker uses the OpenAI Responses API for AI-generated drafts.

## Deploy from GitHub

Use the repository’s [Actions secrets settings](https://github.com/behrens-fangpunkt/jobradar-update/settings/secrets/actions). Create these repository secrets through **New repository secret**.

| Secret | Value |
| --- | --- |
| `OPENAI_API_KEY` | An [OpenAI project API key](https://platform.openai.com/api-keys) with Responses API access and available API billing |
| `ASSISTANT_CODE` | A separate random access code of 24–128 characters using letters, numbers, underscores, or hyphens |
| `CLOUDFLARE_API_TOKEN` | A Cloudflare API token scoped to the account and authorized to deploy Workers |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID for the Worker |

Activate the account’s `workers.dev` subdomain in the Cloudflare Workers dashboard. The [Cloudflare GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) explains how to create the deployment token and find the account ID.

Run [Deploy JobRadar assistant](https://github.com/behrens-fangpunkt/jobradar-update/actions/workflows/deploy-assistant.yml) on `main`. The workflow deploys the Worker, makes one OpenAI request with fictional application details, and prints the **Serveradresse** in the run summary. Successful deployment works with JobRadar v13 on iOS and Android.

In JobRadar, open Settings and expand **KI-Assistent verbinden**. Enter the `/draft` URL from the workflow summary and your separate access code. Then open **Assistent** on a business card, answer the four questions, and choose **KI-Entwurf erstellen**. To rotate the OpenAI API key, replace the GitHub secret and run the workflow again.

The Worker accepts the company name, industry and four answer codes. JobRadar adds the greeting and the applicant name locally. **In Mail öffnen** opens an editable draft in the phone’s mail app. The Worker limits draft requests and sets `store: false` on OpenAI requests.
