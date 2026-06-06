importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey:"AIzaSyBaPN1a6qKdycroI-_IMLQA6ry7qPzrtRo",
  authDomain:"magneetoz.firebaseapp.com",
  projectId:"magneetoz",
  storageBucket:"magneetoz.appspot.com",
  messagingSenderId:"751957852049",
  appId:"1:751957852049:web:1735cbaa412b70ba17a430"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const data = payload.data || {};
  const isOffer = data.type === "offer_broadcast";
  const isOrderStatus = data.type === "order_status";
  const isDeliveryRequest = data.type === "delivery_request";
  const title = payload.notification?.title || (isOffer ? "MAGNEETOZ Offer" : isOrderStatus ? "MAGNEETOZ Order Update" : "New Delivery Request");
  const body = payload.notification?.body || data.body || (isOffer ? "A fresh MAGNEETOZ deal is live." : isOrderStatus ? "Your order status has changed." : "A new MAGNEETOZ order is waiting.");
  self.registration.showNotification(title, {
    body,
    icon:payload.notification?.image || "logo_tran.png",
    badge:"logo_tran.png",
    tag:isOrderStatus ? `order-${data.orderId}-${data.status}` : (data.orderId || data.offerId || "magneetoz-delivery"),
    renotify:isDeliveryRequest,
    requireInteraction:isDeliveryRequest,
    vibrate:isOffer ? [140,70,180] : isOrderStatus ? [160,80,160] : [220,90,220,90,320],
    data,
    actions:isDeliveryRequest ? [
      { action:"accept", title:"Accept" },
      { action:"reject", title:"Reject" }
    ] : []
  });
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const data = event.notification.data || {};
  if(data.type === "offer_broadcast"){
    event.waitUntil(clients.openWindow(`index.html#offersSection`));
    return;
  }
  if(data.type === "order_status"){
    event.waitUntil(clients.openWindow(`index.html?orderId=${encodeURIComponent(data.orderId || "")}#tracking`));
    return;
  }
  const orderId = data.orderId || "";
  const action = event.action || "open";
  const url = `rider-dashboard.html?pushAction=${encodeURIComponent(action)}&orderId=${encodeURIComponent(orderId)}`;
  event.waitUntil(clients.openWindow(url));
});
