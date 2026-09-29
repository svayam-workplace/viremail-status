# Setting up status.viremail.com

About ten minutes, once.

1. **Create the repository.** On GitHub, create `svayam-workplace/viremail-status` as a **public** repository, with no README, licence or .gitignore (this folder already has them).

2. **Push this folder.**
   ```sh
   git init -b main
   git add .
   git commit -m "Viremail status page"
   git remote add origin git@github.com:svayam-workplace/viremail-status.git
   git push -u origin main
   ```
   The page reads its data from the `main` branch. If you use another branch name, change `status-branch` in `index.html`.

3. **Allow the workflow to save results.** Settings, Actions, General, Workflow permissions: choose "Read and write permissions" and save. (The workflow also asks for this itself, but some organisations limit it here.)

4. **Turn on GitHub Pages.** Settings, Pages: Source "Deploy from a branch", Branch `main`, folder `/ (root)`. Save. Under Custom domain, `status.viremail.com` should already be filled in from the `CNAME` file; if not, type it and save.

5. **Add the DNS record in Cloudflare.** In the viremail.com zone, add:

   | Type | Name | Target | Proxy status |
   |---|---|---|---|
   | CNAME | `status` | `svayam-workplace.github.io` | DNS only (grey cloud) |

   It must be DNS only, or GitHub cannot issue the certificate.

6. **Enforce HTTPS.** Back in Settings, Pages, wait until the DNS check passes and the certificate is ready (a few minutes, sometimes up to an hour), then tick "Enforce HTTPS".

7. **Start the checks.** Actions tab: if GitHub asks, enable workflows for this repository. Open "Status checks" and press "Run workflow" once. After it finishes, `data/` has a new commit and the page shows live results. From then on it runs every five minutes on its own.

8. **Make sure incident emails reach you.** Watch the repository (Watch, then All activity, or Custom with Issues). Check that GitHub notification emails for `svayam-workplace` go to an address you read.

## Good to know

- GitHub pauses scheduled workflows in a public repository after 60 days without activity. The data commits count as activity, so this should not happen while the checks run; if the page ever says its results are out of date, open the Actions tab and re-enable the workflow.
- A red workflow run in the Actions tab means the check script itself failed, not Viremail. GitHub emails you about that separately.
- To test incidents without waiting for a real one, you can open an issue with the `incident` label by hand and close it again.
