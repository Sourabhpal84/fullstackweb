"use strict";

const admin = require("../functions/node_modules/firebase-admin");
const growth = require("../functions/services/growthService");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const apply = process.argv.includes("--apply");

async function main() {
  let cursor = null;
  let scanned = 0;
  let changed = 0;
  do {
    let query = db.collection("users").orderBy(admin.firestore.FieldPath.documentId()).limit(200);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    if (snap.empty) break;
    for (const userDoc of snap.docs) {
      scanned += 1;
      const data = userDoc.data() || {};
      const missing = !data.referralCode || data.walletPoints == null || data.lifetimePointsEarned == null ||
        data.lifetimePointsUsed == null || data.successfulReferralCount == null || data.ambassadorStatus == null;
      if (!missing) continue;
      changed += 1;
      console.log(`${apply ? "MIGRATE" : "WOULD MIGRATE"} ${userDoc.id}`);
      if (apply) {
        let phone = data.phone || data.customerPhone || "";
        try { phone = (await admin.auth().getUser(userDoc.id)).phoneNumber || phone; } catch (_) {}
        await growth.initializeUser({ db, FieldValue, uid: userDoc.id, authPhone: phone, profile: data });
      }
    }
    cursor = snap.docs[snap.docs.length - 1];
  } while (cursor);
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", scanned, changed }));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
