# Pterodactyl allocation fix

This version automatically selects an unassigned Pterodactyl allocation instead of blindly reusing one fixed port.

## Behavior
1. Finds nodes in `PTERODACTYL_LOCATION_ID`.
2. Skips maintenance nodes.
3. Reads allocations and keeps only `assigned=false`.
4. Sends the selected allocation ID as `allocation.default`.
5. If another deployment claims it between the check and create request, refreshes and retries up to 6 times.

## Recommended environment
```env
PTERODACTYL_LOCATION_ID=1
PTERODACTYL_USE_FIXED_ALLOCATION=false
```

Keep fixed allocation mode disabled for normal operation.
