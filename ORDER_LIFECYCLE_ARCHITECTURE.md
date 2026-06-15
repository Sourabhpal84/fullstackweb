# Order Lifecycle Architecture

## Source of truth

`orders/{orderId}` is the only document that owns order lifecycle state.

These collections may contain related or cached data, but must not own order status:

- `paymentSessions`
- `paidOrderRecovery`
- `riderRequests`
- `riderWallet`
- `riderSettlements`
- `riderPaymentSessions`
- `users`
- `riders`

No active `activeOrders`, `adminOrders`, `users/{id}/orders`, or `riders/{id}/orders` lifecycle collection is used in this codebase.

## State machine

Lifecycle writes must be forward-only:

1. `Pending`
2. `Accepted`
3. `Rider Accepted` / assigned
4. `Picked Up`
5. `Out For Delivery`
6. `Reached Nearby`
7. `Delivery Code Pending` / OTP verified
8. `Delivered`

Backend writes use `guardedOrderUpdate()` in `functions/index.js`.
Direct client writes are additionally protected by `statusNotMovedBackward()` in `firestore.rules`.

## Payment service

Payment writes use `updatePaymentStatus()` and may only write:

- `paymentStatus`
- `paymentId`
- `transactionId`
- `paidAt`

Payment code must never write:

- `status`
- `orderStatus`
- `lifecycleStatus`
- `deliveryStatus`
- `riderStatus`
- `assignedRider`
- `assignedRiderId`
- `riderId`
- `activeOrder`
- `timeline`
- delivery OTP fields

## Forensic logging

Every guarded order lifecycle write creates `orderWriteAuditLogs/{logId}` with:

- `orderId`
- `actor`
- `source`
- `previousStatus`
- `newStatus`
- `previousOrderStatus`
- `newOrderStatus`
- `changedFields`
- `createdAt`

Payment-only writes also log payment status before/after.

## Dependency map

| File | Function / area | Collection | Write type | Status ownership |
| --- | --- | --- | --- | --- |
| `functions/index.js` | `createOrderFromPaidSession` | `orders` | transaction set/update | New payment-placeholder creation only; existing live orders use payment-only update |
| `functions/index.js` | `verifyPaymentAndCreateOrder` | `paymentSessions`, `paidOrderRecovery`, `orders` | set/update | Payment verification; delegates existing orders to payment service |
| `functions/index.js` | `markOrderPaidFromPayment` | `orders` | transaction update | Payment-only webhook update |
| `functions/index.js` | `updateRiderDeliveryStatus` | `orders` | guarded update | Delivery state machine |
| `functions/index.js` | `createCustomerDeliveryCode` | `orders` | guarded update | OTP state transition |
| `functions/index.js` | `completeDeliveryTransaction` | `orders` | guarded update | Delivery completion |
| `functions/index.js` | `assignRiderToOrder` | `orders`, `riderRequests` | guarded update | Assignment state transition |
| `functions/index.js` | `acceptRiderRequest` | `orders`, `riderRequests` | guarded update | Assignment state transition |
| `functions/index.js` | `riderMarkCashReceived` | `orders` | guarded update | COD collection transition |
| `functions/index.js` | `verifyRiderPayment` | `orders`, `riderPaymentSessions` | guarded update | Rider-collected payment / settlement |
| `8423order9839status.html` | admin status controls | `orders` | client transaction | Protected by Firestore rank rule |
| `rider-dashboard.html` | rider status buttons | Cloud Functions | HTTPS call | Backend state machine owns status |
| `script.js` | customer Pay Now | Cloud Functions | HTTPS call | Payment service owns payment fields only |

## Migration steps

1. Deploy Cloud Functions with `orderStateMachine` and `paymentService`.
2. Deploy Firestore rules with `statusNotMovedBackward()`.
3. Keep existing `orders/{orderId}.status` and `orderStatus`; no data move is required.
4. Review `orderWriteAuditLogs` after deployment for blocked rollback attempts.
5. Once stable, remove legacy client-side direct status writes in admin pages and route them through Cloud Functions.

## Required tests

Run:

```bash
node functions/test/order-state-machine.test.js
```

Covered:

- `Reached Nearby + payment`
- `Out For Delivery + payment`
- `OTP verified + payment`
- payment retry
- delayed webhook
- multiple payment attempts
- forbidden payment payload containing delivery fields
