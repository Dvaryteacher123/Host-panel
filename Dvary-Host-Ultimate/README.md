# DVARY HOST — Bot ZIP Hosting

This build connects the website to one Pterodactyl panel and uses MongoDB. Each uploaded Bot ZIP is its own product.

## Bot onboarding
Dvary Host does **not** force QR, pair code, phone number, or any fixed login flow. After deployment the website opens a private live console for that specific Pterodactyl server. The ZIP/bot controls its own startup messages.

Examples:
- Bot A prints `01. QR Code` / `02. Pair Code`.
- Bot B prints `Enter your WhatsApp number:`.
- Bot C prints its own menu.
The customer sees the actual output and types into the input box. Input is authorized and routed only to that customer's server.

## Bot pricing
Every Bot ZIP has independent prices:
- TZS
- KES
- UGX
- NGN
- GHS
- XAF
- ZAR

Prices are fixed by the admin per country. The bot's money price is never automatically converted from Tanzania pricing.

## Coin Offer
Each Bot ZIP can optionally have its own Coin Offer, for example `100 Coins`. Coins are issued by the admin. Coins are not a generic payment wallet and are not purchased from the normal customer checkout. If the customer has enough Coins, they can deploy that specific bot using the offer.

## Normal payment
Customer chooses a bot → enters server name → chooses country → sees that country's configured price → pays with FimiPay → only after confirmed payment the website creates the Pterodactyl server and installs the Bot ZIP.

## API key
API keys are paid products. The user selects a country, pays the admin-configured API-key price, and the key is generated only after payment confirmation.

## Requirements
Set MongoDB, Pterodactyl URL/API keys, FimiPay credentials and the public callback URL in `.env`. For live console/input the Pterodactyl Client API key must be configured.

## Start
```bash
npm install
npm run seed:admin
npm start
```
