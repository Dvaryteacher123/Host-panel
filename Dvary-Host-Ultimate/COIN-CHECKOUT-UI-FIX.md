# Coin Checkout UI Fix v35

The bot deployment checkout now shows a dedicated, clearly visible **Pay / Deploy with Coins** card directly above the FimiPay section.

For a customer who has an active private Offer assigned by admin for that Bot, the checkout shows:
- Coins to use input
- Offer coin amount
- Current Coin balance
- Deploy Now With Coins button

The Coin payment uses a separate form from the FimiPay form, so the Coin input cannot accidentally be submitted as a cash payment field.

If no private Coin Offer exists for the logged-in customer and Bot, the checkout explicitly says that no private offer is assigned.
