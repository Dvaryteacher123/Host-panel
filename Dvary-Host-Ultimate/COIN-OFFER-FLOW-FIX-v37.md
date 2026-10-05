# v37 Coin Offer Deploy Fix

The customer-facing Deploy page now shows the Coin Deploy card only when there is an ACTIVE Offer belonging to the logged-in user and tied to the EXACT BotTemplate.

Admin flow:
1. Admin -> Offers
2. GIVE COINS only changes the customer's balance.
3. CREATE COIN OFFER FOR DEPLOY -> choose `Specific Bot Coin Offer`.
4. Choose the customer email, Bot, and Offer price in Coins.
5. Click SEND OFFER.
6. The customer refreshes Deploy and the Coin Deploy card appears on that exact Bot.

The deploy POST also requires the Offer to match:
- current customer
- exact BotTemplate
- active, unexpired status
- `plan: null`
- submitted offerId

This prevents a normal plan offer from accidentally appearing as a Bot Coin Offer.
