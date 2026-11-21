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

Run [Deploy JobRadar assistant](https://github.com/behrens-fangpunkt/jobradar-update/actions/workflows/deploy-assistant.yml) on `main`. The workflow deploys the Worker and makes one OpenAI request with fictional application details. JobRadar v14 has the default service URL built in on iOS and Android.

## Approve a phone

1. In JobRadar v14, open **Assistent** on a business card and answer the four questions. On a new phone, use **Freischaltcode teilen** to send its activation code to the repository owner.
2. In GitHub, run **Deploy JobRadar assistant** and paste the activation code into **Phone activation codes**. To approve multiple phones, enter all approved codes separated by commas. To retain current approvals during a redeploy, leave the field empty. To revoke all phone approvals, enter `none`.
3. Once the run succeeds, reopen the assistant or press **Freigabe prüfen**. **KI-Entwurf erstellen** is available on that phone. Its approval persists across app updates.

The shared `ASSISTANT_CODE` still authorizes the deployment test and existing devices configured in v13. The activation code shown by v14 identifies a phone without exposing the private credential generated on it. To rotate the OpenAI API key, replace the GitHub secret and run the workflow again.

The Worker accepts the company name, industry and four answer codes. JobRadar adds the greeting and the applicant name locally. **In Mail öffnen** opens an editable draft in the phone’s mail app. The Worker limits draft requests and sets `store: false` on OpenAI requests.
