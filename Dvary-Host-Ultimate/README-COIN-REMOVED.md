# Dvary Host payment model

## Current model
- Normal server purchases are paid directly with FimiPay money in the customer-selected country currency.
- Bot deployment is paid directly with FimiPay money; the admin sets TZS and per-country prices on the Bot Template.
- API key generation requires a successful FimiPay payment. The generated API key is shown once.
- Coins are NOT sold by the website. The customer coin wallet is not a normal payment method.
- Coins remain only for private Offers. An admin can grant coins to a customer, then that customer can claim an assigned Offer using those coins.
- Offers are coin-only; money payment for an Offer is disabled.

## Country pricing
Admin -> Settings:
1. Enable the countries you want to accept.
2. Set API Key price for TZS and each enabled currency.

Admin -> Plans:
- Set TZS price and fixed KES/UGX/NGN/GHS/XAF/ZAR prices for server plans.

Admin -> Bot Templates:
- Set TZS price and fixed KES/UGX/NGN/GHS/XAF/ZAR prices for bot deployment.

The payment checkout only displays countries enabled by the admin.
