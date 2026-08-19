# Turf Gang

Four frontends for the Turf GDS — a B2B distribution system for turf bookings, launching in Indore.

The backend (`turf_gds`) is a Fastify + MongoDB service that already existed. Everything else is
new and integrates with it.

This was originally one monorepo. It is now five repositories, checked out side by side in a
single parent folder — `scripts/dev.sh` and `scripts/seed.mjs` resolve the apps as siblings of
the backend. Each app repo vendors its own copy of `packages/api-client` and `packages/ui`.

```
<parent>/
├── turf_gds/                 backend — Fastify, MongoDB, Redis, Cloudinary
├── turfgang-admin-portal/    platform operations — Next.js, port 5180
├── turfgang-owner-web/       venue owner dashboard — Next.js, port 5181
├── turfgang-partner-console/ developer platform — Next.js, port 5182
└── turfgang-owner-mobile/    venue owner mobile (React Native CLI)

   each app repo also contains:
   packages/api-client/       typed client; 3 auth modes + HMAC signing
   packages/ui/               design tokens + shared React widgets
├── scripts/seed.mjs          drives the whole onboarding flow against the live API
├── API_CONTRACT.md           verified endpoint reference — read this before touching an app
└── SETUP.md                  how to get the backend and database running
```

## The four apps

**Admin portal** — platform staff. Turf onboarding and approval, two-person KYC review, partner
approvals and API key issuance, contracts, settlements and payouts, reports, system health.
Deliberately plain: conventional sidebar, tables, one clear action per screen.

**Owner web app** — venue owners. Today's bookings and earnings, which turf and time each booking is
for, online vs walk-in, court and slot management, finance. Styled as an instrument dashboard.

**Owner mobile app** — the same venue-owner job on React Native CLI, same visual language, plus push
notifications through the backend's FCM device registration.

**Partner console** — the developer platform. Sandbox and production API keys, usage metering, plans,
webhooks, docs, and turf discovery by location. Modelled on a modern AI developer console.

## Running everything

```sh
npm install             # once, from this directory
./scripts/dev.sh        # MongoDB + API + worker + all three web apps
node scripts/seed.mjs   # a fully-onboarded Indore turf with real bookings
```

`dev.sh status` shows what is up, `dev.sh stop` shuts the backend and web apps down. To run pieces
individually see `SETUP.md`; the web apps are `npm run dev:admin` (5180), `dev:owner` (5181) and
`dev:partner` (5182).

All three web apps are **Next.js 15 (App Router)**. Two things to know if you touch their structure:
screens live in `src/screens/` rather than `src/pages/`, because Next unconditionally treats
`src/pages` as the Pages Router and the build fails on it; and `next dev -p N` **silently moves to
another port** when one is taken, unlike Vite's `strictPort`, so `dev.sh` checks the ports up front
and refuses to start rather than reporting something else's app as yours.

The seed also writes the demo sign-in helper shown on every login screen — `.env.local` for each web
app and a generated `src/demoCredentials.ts` for mobile — so those credentials track the seed instead
of going stale. The block renders nothing when the variables are absent, which is the case in any real
deployment.

The seed drives the entire business flow through the real API — owner registration, KYC with the
two-person review, agreement acceptance, venue approval, courts and slot generation, the full partner
go-live pipeline, a contract, four bookings placed over the signed partner API, and a walk-in with a
payment. It also mirrors a sandbox venue so the developer console's sandbox mode returns real data
rather than looking broken. It prints working logins for all three web apps plus both API key pairs.

The mobile app runs separately (it is intentionally not an npm workspace, because Metro and workspaces
conflict): `cd apps/owner-mobile && npm start`, then `npm run ios` or `npm run android`.

Each app proxies `/api` to `localhost:3000` in development. The backend registers no CORS plugin, so a
production deployment needs either a shared origin behind a reverse proxy or `@fastify/cors` added to
the backend.

## Design language

Taken from the michele.du reference: a black page frame, a light `#f5f5f5` shell floating inside it, and
near-black `#161617` widgets separated only by an 8px gutter — no shadows. Very small uppercase labels
against large light-weight numerals, with Fira Code for annotations. Widgets enter together (opacity and
`scale(0.9 → 1)` after a half-second beat) so the interface reads as instrumentation initialising rather
than a page loading. Tokens live in `packages/ui/src/tokens.ts`, mirrored to CSS variables in
`tokens.css`; the mobile app imports the TypeScript tokens directly.

Beausite Classic is a licensed foundry font, currently loaded from the reference's CDN for fidelity.
Before shipping commercially, either license and self-host it or drop those `@font-face` blocks — the
Inter fallback is already tuned so the layout does not shift.

### Light and dark

All three web apps ship both themes, with a toggle in the app chrome. Dark is the product's default;
with no stored choice the system preference decides, and an explicit choice wins in both directions.
The choice is applied by a small inline script in each root `layout.tsx` before the bundle parses, so
switching never flashes the wrong palette, and `useTheme` corrects itself in a layout effect so the
server and client markup agree (reading `localStorage` during render is a hydration mismatch).

Everything is driven by the tokens in `packages/ui/src/tokens.css` — components reference variables,
never literal colours, so neither theme needs a parallel stylesheet. Two deliberate exceptions:
**code blocks stay dark in both themes** (a terminal should read as a terminal), and scrims stay dark
because dimming is correct on a light page too. The light accents are darker versions of the neon
ones, chosen to clear 4.5:1 contrast against the light card surface rather than picked by eye.

The React Native app currently ships dark only; its tokens are TypeScript constants rather than CSS
variables, so theming it means threading a theme context through the StyleSheets.

### Checking responsiveness

Layout regressions are easy to introduce and hard to see. `scripts/` has no browser harness committed,
but the pattern that found the real bugs here was: drive each route in a headless browser at 390 /
810 / 1440 px and assert `document.documentElement.scrollWidth` never exceeds `clientWidth`. Two
traps caused every failure found so far, and both are worth knowing:

- A flex container with `align-items: flex-start` stacked into a column sizes children to their
  content, not the viewport.
- A grid track of `1fr` means `minmax(auto, 1fr)`, so one wide child sets the track's minimum and
  pushes the page sideways. Use `minmax(0, 1fr)` and `min-width: 0` on grid children.

Never "fix" overflow with `overflow-x: hidden` on the body — it hides the broken layout and silently
clips content the user can then never reach.

### Turf showcase content

`apps/owner-web/src/content/turf-showcase.ts` supplies the gallery and reviews on the Turfs page,
because the backend has neither. The photographs are real and hotlinked from Unsplash, whose licence
permits commercial use without attribution — but they are representative turf pictures, not
photographs of any specific ground, which is why the UI labels them. The reviews are written sample
content, deliberately **not** copied from Google or JustDial: those are their authors' copyright, and
attaching a real person's review of one business to a different venue misrepresents both. Everything
around them is real backend data — venue name, Indore address, coordinates, courts, and the owner's
registered name, email and phone. Replace the module once a reviews endpoint exists; every consumer
reads through `showcaseFor()`.

## Things the backend does not do

Worth knowing before promising any of it, and each one is real backend work:

- **No booking approval flow.** Bookings are confirmed immediately; there is no pending state and no
  accept/reject. Owners can only cancel their own walk-in (`DIRECT`) bookings — partner bookings are
  read-only to them.
- **No plans or billing for the API.** Only admin-set rate-limit tiers exist. The console presents the
  tiers and routes an upgrade as a request.
- **Partners cannot issue or list their own API keys.** Issuance is admin-only and secrets are shown once.
- **No password reset, email verification, or invite-by-email.** Adding a team member takes an existing
  owner id.
- **Payout accounts need a tokenisation vault** that no endpoint provides, so that form cannot be
  completed yet.
- **No city model.** Turf discovery is latitude/longitude plus a radius, so "Indore first" is a default
  map centre rather than a backend filter.
