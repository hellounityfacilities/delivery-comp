# Multi-Vertical Delivery Platform (Qatar)

Talabat/Snoonu-style delivery platform: food, grocery, pharmacy and parcels, delivered by an employed rider fleet.
One Node.js backend serves the API, real-time events, and all four web apps from a single process (one Railway service).

## What's here

| Path | What it is |
|---|---|
| `server/` | Express + PostgreSQL API, Socket.io real-time, order state machine, auto-dispatch, double-entry ledger |
| `apps/customer/` | Customer app (mobile web / PWA-ready): browse, cart, checkout, parcels, live tracking |
| `apps/merchant/` | Merchant app: order queue with sound, prescription approval, catalog, reports |
| `apps/rider/` | Rider app: clock in/out, task acknowledge (60 s), navigation, proof of delivery, cash |
| `apps/console/` | Operations console: live map, order board, manual dispatch, fleet & cash settlement, stores, zones, promos, finance, users |
| `apps/shared/` | Shared design tokens and API/auth/i18n helpers (EN/AR with RTL) |
| `docs/delivery-platform-prd.html` | Client-facing product requirements document |

## Run locally

```bash
cd server
cp .env.example .env          # set DATABASE_URL to a Postgres database
npm install
npm run seed                  # RESETS the database and loads a full Doha demo dataset
npm start                     # http://localhost:3000
```

Apps: `/customer/`, `/merchant/`, `/rider/`, `/console/`.

In development the OTP code is always **123456**. Seeded accounts:

| Role | Phone |
|---|---|
| Admin | +97455000010 |
| Dispatcher | +97455000011 |
| Fleet manager | +97455000012 |
| Finance | +97455000013 |
| Merchants (4 stores) | +97455000001 … +97455000004 |
| Riders | +97455000021, +97455000022 |
| Customer | any other number |

Demo walkthrough: sign in as a rider and clock in → as a customer, set an address inside Doha and place an order → as the merchant, accept it → the rider gets the task automatically → console shows it all live.

## Deploy to Railway

1. Create a project with a PostgreSQL plugin; copy its `DATABASE_URL`.
2. Deploy this repo. Root directory: `server`. Start command: `npm start`.
3. Set variables: `DATABASE_URL`, `PGSSL=true`, `JWT_SECRET` (long random string), `NODE_ENV=production`.
4. Run `npm run seed` once (Railway shell) or onboard stores from the console.

In production the OTP is generated randomly and must be sent by SMS — wire your provider in `server/src/auth.js` (`issueOtp`).

## Architecture notes

- **Order state machine** — `server/src/services/orders.js`. Every transition checks the allowed next state and the role allowed to trigger it, and records an event. Pharmacy items with `requires_approval` route the order through `awaiting_approval`; parcels auto-accept.
- **Dispatch** — `server/src/services/dispatch.js`. On merchant accept (or ready), the nearest available in-zone rider by estimated travel time is auto-assigned; riders over their cash limit are excluded. The rider must acknowledge within `ACK_WINDOW_MS` (default 60 s) or the order is reassigned and ops alerted. Dispatchers can override from the console. No batching in v1 (one live task per rider).
- **Ledger** — `server/src/services/ledger.js`. Card/wallet payments post at checkout; delivery posts merchant payable, commission, delivery and service revenue, and rider cash for COD. Refunds credit the customer wallet. Rider cash settlement moves cash from `cash_riders` to `cash_office`.
- **Real-time** — Socket.io rooms per user, store, rider, order and an `ops` room. Rider GPS is forwarded to the customer tracking the order and to the ops map.
- **Zones** — polygons stored as JSON; point-in-polygon and haversine in JS (no PostGIS dependency, easy to host anywhere).

## Roadmap (next phases)

- Card gateway integration (Skipcash / Dibsy) replacing the stubbed capture; Apple Pay.
- Order batching, scheduled delivery slots, surge pricing.
- Grocery substitution flow with customer approval.
- Push notifications (FCM) and SMS provider.
- Native wrappers (Capacitor or React Native) for app-store distribution.
- Redis pub/sub for multi-instance scaling.
