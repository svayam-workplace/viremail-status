# Viremail status

The public status page for Viremail, at [status.viremail.com](https://status.viremail.com).

It runs entirely on GitHub: the checks run in GitHub Actions, the results live in this repository, incidents are GitHub issues and the page is served by GitHub Pages. Nothing here depends on Viremail's own servers, so the page keeps working when Viremail does not.

## What is checked

Every five minutes (GitHub sometimes runs scheduled jobs a little late), [`scripts/run.mjs`](scripts/run.mjs) runs these checks. They are read-only and never sign in.

| Service | Check | Passes when |
|---|---|---|
| Website and app | Home page and web app | `https://viremail.com/` answers 200 and contains the app |
| Website and app, Sign-in | App service health | `https://viremail.com/api/health` answers `{"ok":true}` |
| Website and app | Features page | `https://viremail.com/features` answers 200 |
| Website and app | Domain name viremail.com | viremail.com resolves (asked of public resolvers) |
| Sign-in | Sign-in page | `https://viremail.com/login` answers 200 and contains the app |
| Mail sending | Port 465 (secure) | mail.viremail.com completes a secure connection and greets us |
| Mail sending | Port 587 | mail.viremail.com greets us |
| Mail sending, Mail access | Mail domain records | mail.viremail.com resolves and viremail.com's mail records point to it |
| Mail access | Port 993 (secure) | mail.viremail.com completes a secure connection and greets us |
| Desktop downloads | Desktop download page | `https://viremail.com/desktop` answers 200 |
| Desktop downloads | Desktop update list | the latest desktop `release.json` downloads and has a version |

For mail, the check only waits for the server's first line, checks its shape, and says goodbye. It never logs in and never stores or prints what the server says. Each result records whether it passed, how long it took and, if it failed, a short reason such as "Timed out" or "Certificate expired".

A failed check is retried once, three seconds later, before it counts. If the runner cannot reach GitHub either, the whole run is ignored, because then the problem is the runner's network, not Viremail.

## Where the results go

All files are small and are rewritten in place, so the repository grows slowly.

- `data/current.json`: the latest result of every check, the service groups, and which incidents are open.
- `data/uptime.json`: minutes checked and minutes with problems, per check, per day, for 90 days.
- `data/response.json`: the last 72 saved response times per check (about three days).
- `data/notices.json` and `feed.xml`: the incident and maintenance issues, saved for the page and as an Atom feed.

The workflow commits only when something changed (a check starts or stops failing, an incident opens or closes, a note is added) or when the last save is an hour old. Uptime is counted in minutes, so skipped saves lose nothing: a run that is not saved had the same result as the last saved one.

On status.viremail.com the page reads its data straight from this repository on `raw.githubusercontent.com`, so it stays fresh even if a GitHub Pages rebuild is slow. The copy served by Pages (and `feed.xml`) updates when Pages rebuilds after each data commit.

## How incidents work

- When any check in a service fails **twice in a row**, the workflow opens an issue labelled `incident`, `automated` and the service (for example `mail-sending`). GitHub emails everyone watching the repository, including the owner.
- When every check in that service passes again, the workflow comments with the time and how long it lasted, and closes the issue.
- You can add notes to an open incident as comments. The page shows comments from the owner, members and collaborators, and from the checks themselves. Comments from anyone else are not shown.
- If you close an automated incident by hand while the checks are still failing, the workflow leaves it closed until the service recovers.

## Adding a manual incident or a maintenance notice

Open an issue in this repository and add a label:

- `incident` for a problem the checks cannot see (for example, some messages arriving late).
- `maintenance` for planned work. Put the time in the title, in UK time, for example "Mail access maintenance, Sunday 5 October, 02:00 to 02:30 UK time", and any details in the description.

Add a service label as well (`website`, `sign-in`, `mail-sending`, `mail-access` or `desktop`) to show which service it affects.

Open issues show under "Happening now". Close the issue when the work is done or the problem is fixed, and it moves to the history. Only people with write access can add labels, so nobody else can put a notice on the page. The labels are created automatically the first time the workflow opens an incident; you can also create them yourself.

## Updates for visitors

- The Atom feed at [status.viremail.com/feed.xml](https://status.viremail.com/feed.xml) lists incidents and maintenance.
- Anyone can watch this repository (Watch, then Custom, then Issues) to get GitHub emails for every incident.

## The page

`index.html`, `assets/style.css` and `assets/status.js`. No frameworks, no third-party scripts, no cookies and no trackers. It reads the data files above and, for the latest incidents and comments, the public GitHub API without signing in. Answers from GitHub are cached in the browser for two minutes and asked again with ETags, and if GitHub's limit for unsigned requests is reached, the page falls back to the saved `data/notices.json`.

Light and dark follow the visitor's system setting. The daily bars and response time charts work with a mouse, a tap or the arrow keys, and each has a text summary for screen readers.

## Running it yourself

Node 24, nothing to install.

```sh
node scripts/run.mjs --dry   # run every check and print the results, write nothing
node scripts/run.mjs         # also update data/ (incidents only happen inside the workflow)
python3 -m http.server       # then open http://localhost:8000
```

To change what is checked, edit `CHECKS` and `GROUPS` in [`scripts/checks.mjs`](scripts/checks.mjs).
