# Coin Deploy UI Fix v34

The Deploy Bot page now has an explicit, visible **WEKA COINS** field for customers who have an active private coin offer for that bot.

Flow:
1. Admin gives a private coin offer to a customer for a specific bot.
2. Customer opens **Deploy Bot**.
3. The bot card shows **DEPLOY WITH COINS**.
4. Customer enters server name and Coins amount.
5. Backend validates the offer ID, customer, bot, exact coin amount, balance, and then debits Coins.
6. Deployment is queued. If deployment fails, Coins are refunded by the deployment service.

Customers without an active offer do not get the coin-deploy form.
