# Private Coin Offers for Deploy

Admin can now give a private coin offer directly for a specific Bot Template to one customer email.

Flow:
1. Admin -> Offers -> Offer type = Specific Bot.
2. Select customer email, bot and coin price.
3. Customer sees the offer on Store and, more importantly, when opening Deploy for that bot.
4. The Deploy checkout shows **USE COINS & DEPLOY** only when that logged-in customer has an active offer for that exact bot.
5. The offer is atomically marked used before deployment; coins are deducted safely and refunded if the deploy job fails.
6. Other customers do not see or get that private coin option. They can use the normal country/FimiPay payment flow.
