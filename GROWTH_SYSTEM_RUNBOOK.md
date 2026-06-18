# MAGNEETOZ Growth System

## Deployment order

1. Deploy Cloud Functions.
2. Deploy Firestore rules and indexes.
3. Run the user migration in dry-run mode, then apply it.
4. Deploy Hosting.

```powershell
firebase deploy --only functions
firebase deploy --only firestore:rules,firestore:indexes
node scripts/migrate-growth-users.js
node scripts/migrate-growth-users.js --apply
firebase deploy --only hosting
```

## Phase 1

- `profile.html`: profile, optional birthday, saved addresses, Pizza Points, wallet history, recent orders and Refer & Earn.
- Checkout phone is read from Firebase Authentication and is no longer editable.
- `attachReferralToUser`: immutable referral attachment with self-referral and duplicate-phone checks.
- `processGrowthRewardsOnDelivery`: credits rewards only on the first delivered order.
- Admin point adjustments create an immutable wallet ledger entry.

## Phase 2

- Ambassador application is available from the profile page.
- Admin review, cash/percentage/flat reward configuration and withdrawal processing are backend operations.
- Ambassador rewards use a separate ledger and cannot run alongside normal referral rewards for one order.

## Collections

- `walletTransactions`
- `referralEvents`
- `growthOrderEvents`
- `referralCampaigns`
- `ambassadorApplications`
- `ambassadors`
- `ambassadorTransactions`
- `ambassadorWithdrawals`
- `settings/growthRewards`

## Required settings

Create `settings/growthRewards` to override defaults:

```json
{
  "referralEnabled": true,
  "walletRedemptionEnabled": true,
  "referrerRewardPoints": 10,
  "referredUserBonusPoints": 20,
  "walletMaxRedemptionPercent": 20,
  "walletMinimumOrderValue": 0,
  "walletAppliesToDeliveryFee": false,
  "birthdayRewardPoints": 0,
  "ambassadorMinimumWithdrawal": 100
}
```

No new environment variables are required. Existing Firebase and Razorpay configuration remains unchanged.

## Verification

- Login with phone OTP and confirm the profile shows the authenticated number.
- Confirm checkout has no editable phone input and orders retain the authenticated number.
- Open `/?ref=CODE`, log in with a different phone, and confirm `referralEvents/{userId}` is attached once.
- Deliver the referred user's first order and confirm exactly two wallet transactions are created.
- Retry the delivery trigger and confirm balances do not change.
- Cancel/refund an order and confirm no reward is credited.
- Submit an ambassador application, approve it through the admin endpoint, deliver a tracked order, and verify the ambassador ledger.
- Request, reject and pay withdrawals; verify pending/withdrawable balances.
- Re-run the existing order state-machine tests and complete COD/Razorpay smoke tests.

## Rollback

1. Disable `referralEnabled` and `walletRedemptionEnabled` in `settings/growthRewards`.
2. Roll back Hosting to the previous Firebase Hosting release.
3. Remove/disable the growth triggers if necessary; do not delete ledger collections.
4. Restore the previous rules only after disabling profile UI writes.
5. Reconcile any credited entries using compensating `admin_debit` transactions—never edit or delete ledger history.
