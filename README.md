# KAMRADS — Auction Intelligence

Watches Pickles, Manheim, ALLBIDS (incl. CARBIDS), Lloyds, Grays, Slattery and The Auction Barn, lists every lot by what ends soonest, and pushes an alert to your phone when something is still cheap in its final 10 minutes.

**Market research:** add your Claude API key under **Settings** (bottom of the dashboard — it's stored on the server only). Claude then searches carsales, Gumtree, Drive, RedBook and others for comparable listings, gives a market average and a realistic resale range for each lot, and flags great prices. Press **Research** on any lot to run it on demand. Automatic lookups have a daily cap (default 60, about 5–10c each).

**Logins:** everyone gets their own login (`DASH_USER`/`DASH_PASS` plus `DASH_USERS=matthew:password` in `.env`), and with it their own watchlist, bids, alerts and phone link.

**My watchlist** sits at the top of the dashboard: star any lot (or paste its link) and its price is re-checked every 60 seconds until it closes. Press **I'm bidding** / **Bid** and enter the most you've bid. The sites use max (proxy) bidding, so while the price is at or under your max you're **winning**; once it passes your max you're **OUTBID** and your phone gets a push. At the close you get "looks like you won" or "lost".

**My alerts** (🔔): type what you're after, e.g. `renault master, mercedes sprinter, hiace -crash`, with an optional max price. You get a push when a new one is listed, and again in its final 10 minutes if it's still at or under your max.

**Sectors:** lots are sorted into Vehicles (cars & utes, vans & buses, trucks & prime movers, trailers, motorbikes, boats & caravans), Freight & plant (forklifts & warehouse, plant & machinery, tools & electrical) and Business equipment (vending & retail, hospitality & laundry, IT & office). Paint, household bits and the like go in **General goods**, kept off the main board and out of penny-lot pushes (`PENNY_GENERAL=true` to include them).

**Privacy:** lot photos are fetched by the KAMRADS server and links out carry no referrer, so the auction sites never see the dashboard's address; search engines are told not to index it.

**More filters:** price range, year, km, type (cars, vans, trucks, bikes, machinery, boats, goods), write-off status, bids, closing day and state.

**Missed deals** tab: bargains that closed without you — under half the estimate or market price, vehicles under $3,000, penny lots. Only lots read within 15 minutes of the close count, so the prices are real.

**All-in cost:** every lot shows what you'd really pay: bid + buyer's premium / fee (+GST where listed) + rough transport to your home base, and deals and profit are judged on that. Fees are estimates from each site's usual terms (a lot's own "Buyer's Premium x%" wins); change them in `.env`.

**Distance:** 📍 km from your home base (Karnup or Canberra, set in Settings), a **Max distance** filter and **Nearest first** sort. Suburbs are looked up once on OpenStreetMap and cached.

**Sold here:** for vehicles, what similar lots (same make/model, similar year, same write-off class) actually went for in our own results. With 3+ results it becomes the estimate, and paid research is skipped when there are 5+.

**Check listing:** Claude reads the description and photos for deal-breakers (won't start, no keys, flood, hail, missing parts) and gives OK / check / red flags. It runs by itself once for any lot someone has bid on.

**Bidding against each other:** if you and Matthew both enter a bid on the same lot, both of you see a warning and the other person gets a push.

**Morning digest:** one push at 7am (change hour, time zone or turn it off in Settings): your alert matches closing today, the best deals, your watchlist, yesterday's missed deals.

## Freight board (`/freight`)

Same login, at **kamrads.katara.com.au/freight** (or the 🚚 Freight button). It reads Airtasker's public delivery, removals, courier, man-with-a-van and ute job lists (nationally plus Canberra and Sydney) and the Truckit job board, every 10 minutes.

- **Plan a run:** type *Canberra → Sydney*, a detour allowance and tick *and back*: jobs that fit on the way out and return loads home are marked and listed first, with the extra km each adds. Leave "to" blank for everything around one place.
- **Routes & alerts:** save runs ("Sydney run": Canberra ⇄ Sydney, 30 km detour) or areas ("within 25 km of Canberra, at least $100") and get a push the moment a new job fits. Each person has their own.
- Each job shows its route, job km, price and $ per km, and how far the pickup is from your home base.
- More cities: `AIRTASKER_CITIES=canberra|sydney|wollongong` in `.env`. Airtasker is read from its public category lists only (never individual task pages), every 10 minutes.
- If Truckit's board needs a login, sign in on your own Chrome, export cookies with Cookie-Editor and run `docker compose exec kamrads npm run import-cookies -- truckit data/truckit-cookies.json`.

**History:** everything is kept in `data/auctions.db` on the server (every lot, every price change, every final price), with a daily copy in `data/backups/` (last 14 days). **Download all results (CSV)** at the bottom of the dashboard opens in Excel; bid history is at `/api/export/bids.csv`.

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
| Status pill red, log says "blocked" | The site is refusing the US server. Set `MANHEIM_PROXY_URL` (or `PROXY_URL` for every site) to an Australian residential proxy and restart. |
| Grays / Slattery / Auction Barn find 0 lots | Their link patterns are in `src/sites/extra.js`; run the probe on one lot and send the developer `data/probe/`. |
| "login failed" in the log | Run `docker compose exec kamrads npm run login -- pickles`. If it still fails (captcha / 2FA), log in on your own Chrome, export cookies with the Cookie-Editor extension, copy the file to `data/`, then `docker compose exec kamrads npm run import-cookies -- pickles data/pickles-cookies.json` and `docker compose restart`. |
| Lots appear but with no bid or close time | Run the probe on one lot and send the developer the folder it creates: `docker compose exec kamrads npm run probe -- <lot url>` (output in `data/probe/`). |
| Server memory | `docker stats kamrads` — the container is capped at 1.2 GB. |

Updates deploy automatically on every push to `main` (tests run first). Data lives in `./data` and survives updates.

## How alerts decide

In the final `ALERT_MINUTES` (10) of an auction:

- **SLEEPER** — bid at or under 25% of the resale estimate (your own estimate from the "Est" button wins over the AI's).
- **CHEAP** — no estimate yet, it's a vehicle, and it's still under `CHEAP_VEHICLE_MAX` ($3,000).
- **PENNY LOT** — anything still at $5 or less.
- **WATCHED** — anything you starred: a personal push to each person watching, saying if they're winning or outbid.
- **OUTBID** — any time the price passes the max you entered (not just the final minutes).
- **MATCH** — one of your saved alerts, still at or under its max price.

Statutory write-offs never alert unless starred: they can never be re-registered.

Each lot alerts once per type. Lots closing within 15 minutes are re-checked every 30 seconds; within an hour, every 5 minutes; everything else on the 10-minute scan.
