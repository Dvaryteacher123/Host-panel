# DVARY HOST ULTIMATE — Version 1 (Coins + Manual Admin Approval)

Hosting platform: users register, request coins, admin approves, users buy servers, servers are created automatically on Pterodactyl.
**Version 1 has no payment gateway.** Payment is done outside the website; admin verifies and adds coins. (Automatic payment = Version 2, later.)

## 1. Requirements
- Node.js 18 or newer (20/22 recommended)
- MongoDB 5+ (local or Atlas)
- A Pterodactyl panel with an **Application API key** (`ptla_...`)

## 2. Install Node.js
Download from https://nodejs.org (LTS). Check: `node -v`

## 3. MongoDB
Local: install MongoDB Community and start it (`mongodb://127.0.0.1:27017/dvary_host`).
Or use MongoDB Atlas and paste its connection string into `MONGODB_URI`.

## 4. Install
```
npm install
```

## 5. .env
```
cp .env.example .env
```
Edit `.env`: set a long random `SESSION_SECRET`, `MONGODB_URI`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`.
Set `COOKIE_SECURE=true` when the site runs on HTTPS.

## 6. Create admin
```
npm run seed:admin
```
Then delete `ADMIN_PASSWORD` from `.env` if you like.

## 7. Pterodactyl API
Panel → Admin → Application API → Create key (Read & Write for Servers, Users, Nests, Eggs, Locations).
Put in `.env`: `PTERODACTYL_URL` (no trailing slash), `PTERODACTYL_API_KEY`, `PTERODACTYL_NEST_ID`, `PTERODACTYL_EGG_ID`, `PTERODACTYL_LOCATION_ID`.
- Servers are placed automatically on a free allocation in the location (Pterodactyl "deploy"). Make sure the nodes in that location have free allocations. Or set `PTERODACTYL_ALLOCATION_ID` for one fixed allocation.
- Docker image and startup default to the egg's values; override per service template or with `PTERODACTYL_DOCKER_IMAGE` / `PTERODACTYL_STARTUP`.
- Each customer gets a panel user with their email. A random password is generated and **not stored**; the customer uses "Forgot password" on the panel to set their own.
- Check status in Admin → Settings.

## 8. Start
```
npm start
```
Open http://localhost:3000 (dev mode: `npm run dev`).

## 9. Create plans (Admin → Plans)
Name, description, coin price, RAM (MB), disk (MB), CPU (%), databases, backups, active. You can edit, enable or disable any plan. Only active plans show in the store.

## 10. Create bot/service templates (Admin → Services / Bots)
Name, Egg ID, Docker image, startup command, environment (`KEY=VALUE` per line). Customers pick one when buying.

## 11. Manage users (Admin → Users)
Search, view a user's servers and transactions.

## 12. Add coins
Admin → Users → choose user, amount, reason → **GIVE COINS**. Creates a `credit` transaction.

## 13. Approve coin requests
User: Coins → Request Coins (amount + payment reference).
Admin: Coin Orders → check your payment → **APPROVE** (adds coins, credit transaction) or **REJECT** (no coins).

## 14. Deploy servers
User: Server Store → name, plan, service → **BUY SERVER**.
Flow: check balance → atomic debit + transaction → server record → Pterodactyl user → Pterodactyl server → save ID/identifier/panel URL.
If Pterodactyl fails, coins are **refunded automatically** (`refund` transaction) and no server is kept.

## Notes
- Wallet changes use atomic MongoDB updates (no negative balance, no double spend). Approving an order is also atomic.
- CSRF tokens on all forms, bcrypt passwords, HTTP-only sameSite cookies, admin middleware, errors only in server logs.
- CSS is inside each `.ejs` page (`<style>`); no external CSS or CDN.

## Extra features in this build
- **ZIP bot deploy:** Admin → Services / Bots uploads a private `.zip` for each bot template. The website creates the Pterodactyl server, waits until it is ready, uploads the ZIP contents directly to `/home/container/`, then starts the bot (or waits for the phone number when pairing is enabled).
- **Admin power tools:** give/take coins, change role, suspend users, reset passwords, suspend/unsuspend/delete servers (optional refund), enable/disable plans and templates, site settings (name, support link, payment instructions, announcement banner, maintenance mode, registration on/off).
- **Audit Log:** every admin action is recorded (Admin → Audit Log).
- **Mobile:** hamburger sidebar and bottom navigation; every page has its own inline CSS.
- Version 1 still has **no** payment gateway; automatic payment is for Version 2.

## New in this build

### Customer tools (on each server page)
- **Delete my server**: the customer can delete his own server (confirmation first, no refund). Suspended servers cannot be deleted by the customer.
- **WhatsApp pairing**: a phone-number box. The number is written into the bot's egg variable on the panel and the bot restarts, so no panel login is needed.
  Admin → Services / Bots → set **Phone variable name** (the egg variable your bot reads, e.g. `NUMBER`). If it is empty the box is hidden.
- **Live console**: real-time console output plus Start / Restart / Stop / Kill buttons.
- **Community chat**: `/dashboard/community`. Admins can delete messages and mute users.
- **Bigger cards**, **bot picture** (Admin → Services / Bots → Bot image URL), **EN / SW** language button (🌐).

### Live console setup (required)
Add to `.env` / Render Environment:
```
PTERODACTYL_CLIENT_API_KEY=ptlc_...
```
Create it from a **root admin** account on the panel: Account (top right) → **API Credentials** → Create. A root admin's key can reach every customer's server.
`PTERODACTYL_URL` must be exactly the panel's own URL (same as its APP_URL), because Wings only accepts the console connection from that origin.
Run `npm install` again (new dependency: `ws`).

### Security changes
- Existing panel accounts are no longer touched: their password is **not reset or shown** (before, anyone could register with the panel admin's email and take over that account). A password is generated only for brand-new panel accounts and shown once.
- Request bodies (including passwords) are no longer written to the server logs.


## New in v9: Admin Panel plans + Notifications

### Admin Panel (customer becomes root admin of your Pterodactyl panel)
- Create it in **Admin → Plans → 👑 Admin Panel Plans** (name, coin price, description). Normal server plans stay separate.
- Customers see it in **Buy Server** under "👑 Admin Panel". When they buy: coins are debited, their panel account is found or created, and it is set to **root admin** in Pterodactyl. A new panel password is shown once (they can reset it from the same page). If anything fails, coins are refunded automatically.
- The Application API key must have **Users: Read & Write**.
- The buyer then works inside Pterodactyl itself: users, servers, nodes, everything.
- **Revoke**: Admin → Users → open the user → **REVOKE PANEL ADMIN** (removes root admin on the panel).
- **Delete user**: Admin → Users → open the user → **DELETE USER** (removes his panel servers first, and his panel account if this site created it; revokes panel admin otherwise).
- WARNING: a Pterodactyl root admin controls the whole panel and its nodes (including your own admin account). Sell it only to people you trust.

### Notifications
- **Bell 🔔** at the top of every page with a red unread counter; opens **/dashboard/notifications** (also in the sidebar). Members read all notifications, new ones are marked NEW.
- Owner: **Admin → Notifications** → add (title, message, type) and delete any.
- New files: `models/Notification.js`, `routes/notifications.js`, `services/userService.js`, `views/partials/bell.ejs`, `views/*/notifications.ejs`. No new npm packages.
