# KAMRADS — Auction Intelligence

Watches Pickles, Manheim and ALLBIDS (incl. CARBIDS), lists every lot by what ends soonest, and pushes an alert to your phone when something is still cheap in its final 10 minutes.

**My watchlist** sits at the top of the dashboard: star any lot (or paste its link) and its price is re-checked every 60 seconds until it closes.

Every lot gets one last read just after it closes, so the **Sold** tab shows what things actually went for — the auction sites hide this once a lot ends.

Server: RackNerd 2 GB KVM, `198.84.85.8`, Ubuntu 24.04.

## Install (one time, about 15 minutes)

**1. On the server**, as root:

```
ssh root@198.84.85.8
apt-get update && apt-get install -y git
ssh-keygen -t ed25519 -N "" -f ~/.ssh/kamrads_deploy -C kamrads-deploy
cat ~/.ssh/kamrads_deploy.pub
```

On GitHub open **AZTech-io/kamrads → Settings → Deploy keys → Add deploy key**, paste that public key (read-only is fine).

```
cat >> ~/.ssh/config <<'CFG'
Host github.com
  IdentityFile ~/.ssh/kamrads_deploy
CFG
git clone git@github.com:AZTech-io/kamrads.git /root/kamrads
cd /root/kamrads && ./setup.sh
nano .env                      # passwords, buyer logins, ntfy topic
docker compose up -d --build
docker compose logs -f kamrads
```

**2. Turn on auto-deploy** so every push to `main` goes live by itself:

```
ssh-keygen -t ed25519 -N "" -f ~/.ssh/github_actions -C github-actions
cat ~/.ssh/github_actions.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/github_actions        # copy this PRIVATE key
```

In **Settings → Secrets and variables → Actions**: add secrets `VPS_HOST` = `198.84.85.8`, `VPS_USER` = `root`, `VPS_SSH_KEY` = the private key, and under the Variables tab add `DEPLOY_ENABLED` = `true`.

**3. Open the dashboard.** Quick way, from your own computer:

```
ssh -L 8787:localhost:8787 root@198.84.85.8
```

then browse to http://localhost:8787. For a permanent link on your phone, create a Cloudflare Tunnel (Zero Trust → Networks → Tunnels → Create, service `http://localhost:8787`), paste its token into `CF_TUNNEL_TOKEN`, add a Cloudflare Access policy for your email, and run `docker compose --profile tunnel up -d`.

**4. Test the phone alert:** click "Send a test alert" at the bottom of the dashboard.

## If something isn't working

| Symptom | Fix |
| --- | --- |
| Status pill red, log says "blocked" | The site is refusing the US server. Set `PROXY_URL` to an Australian proxy and restart. |
| "login failed" in the log | Run `docker compose exec kamrads npm run login -- pickles`. If it still fails (captcha / 2FA), log in on your own Chrome, export cookies with the Cookie-Editor extension, copy the file to `data/`, then `docker compose exec kamrads npm run import-cookies -- pickles data/pickles-cookies.json` and `docker compose restart`. |
| Lots appear but with no bid or close time | Run the probe on one lot and send the developer the folder it creates: `docker compose exec kamrads npm run probe -- <lot url>` (output in `data/probe/`). |
| Server memory | `docker stats kamrads` — the container is capped at 1.2 GB. |

Updates deploy automatically on every push to `main` (tests run first). Data lives in `./data` and survives updates.

## How alerts decide

In the final `ALERT_MINUTES` (10) of an auction:

- **SLEEPER** — bid at or under 25% of the resale estimate (your own estimate from the "Est" button wins over the AI's).
- **CHEAP** — no estimate yet, it's a vehicle, and it's still under `CHEAP_VEHICLE_MAX` ($3,000).
- **PENNY LOT** — anything still at $5 or less.
- **WATCHED** — anything you starred.

Statutory write-offs never alert unless starred: they can never be re-registered.

Each lot alerts once per type. Lots closing within 15 minutes are re-checked every 30 seconds; within an hour, every 5 minutes; everything else on the 10-minute scan.
