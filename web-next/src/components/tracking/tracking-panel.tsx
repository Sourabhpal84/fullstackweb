"use client";

import { X } from "lucide-react";
import type { CustomerOrder } from "@/types/domain";
import { formatCurrency, timestampToDate } from "@/lib/format";

export function TrackingPanel({ open, onClose, orders }: { open: boolean; onClose: () => void; orders: CustomerOrder[] }) {
  return (
    <div className={`fixed inset-0 z-[80] bg-black/70 backdrop-blur-xl transition-opacity duration-200 ${open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}>
      <section className={`ml-auto h-full w-full max-w-2xl transform overflow-y-auto bg-[#07111f] transition-transform duration-300 ${open ? "translate-x-0" : "translate-x-full"}`}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/10 bg-[#07111f]/92 p-4 backdrop-blur-xl">
          <div>
            <h2 className="text-xl font-black">Live Orders</h2>
            <p className="text-xs font-semibold text-white/55">Realtime tracking and rider location</p>
          </div>
          <button className="grid h-10 w-10 place-items-center rounded-full bg-white/10" onClick={onClose} aria-label="Close tracking"><X size={18} /></button>
        </div>
        <div className="space-y-4 p-4">
          {orders.length ? orders.map((order) => <OrderCard key={order.id} order={order} />) : (
            <div className="rounded-3xl border border-white/10 bg-white/[.06] p-8 text-center">
              <h3 className="text-lg font-black">No live orders</h3>
              <p className="mt-2 text-sm text-white/60">Your active orders will appear here after login.</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function OrderCard({ order }: { order: CustomerOrder }) {
  const date = timestampToDate(order.createdAt);
  return (
    <article className="rounded-3xl border border-white/10 bg-white/[.06] p-4 shadow-glow">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-black">#{order.orderNumber || order.id}</h3>
          <p className="text-xs text-white/50">{date ? date.toLocaleString() : "Live order"}</p>
        </div>
        <span className="rounded-full border border-cyan-200/30 bg-cyan-200/10 px-3 py-1 text-[11px] font-black text-cyan-100">{order.status || "Pending"}</span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-2xl bg-black/25 p-3">
          <span className="text-xs text-white/50">Total</span>
          <strong className="block">{formatCurrency(order.totalAmount || 0)}</strong>
        </div>
        <div className="rounded-2xl bg-black/25 p-3">
          <span className="text-xs text-white/50">Payment</span>
          <strong className="block">{order.paymentMethod || "COD"}</strong>
        </div>
      </div>
      {order.riderName || order.riderLocation ? (
        <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-3">
          <h4 className="font-black text-cyan-100">Delivery Partner</h4>
          <p className="mt-1 text-sm text-white/75">{order.riderName || "Rider assigned"}</p>
          {order.riderLocation?.lat && order.riderLocation?.lng ? <RiderMap order={order} /> : <p className="mt-3 text-xs text-white/55">Waiting for rider GPS.</p>}
        </div>
      ) : null}
    </article>
  );
}

function RiderMap({ order }: { order: CustomerOrder }) {
  const riderLat = Number(order.riderLocation?.lat);
  const riderLng = Number(order.riderLocation?.lng);
  const customerLat = Number(order.location?.lat);
  const customerLng = Number(order.location?.lng);
  const hasCustomer = Number.isFinite(customerLat) && Number.isFinite(customerLng);
  const south = hasCustomer ? Math.min(customerLat, riderLat) - .012 : riderLat - .018;
  const north = hasCustomer ? Math.max(customerLat, riderLat) + .012 : riderLat + .018;
  const west = hasCustomer ? Math.min(customerLng, riderLng) - .012 : riderLng - .018;
  const east = hasCustomer ? Math.max(customerLng, riderLng) + .012 : riderLng + .018;
  const markerQuery = hasCustomer ? `marker=${customerLat},${customerLng}&marker=${riderLat},${riderLng}` : `marker=${riderLat},${riderLng}`;

  return (
    <iframe
      title="Live rider location"
      loading="lazy"
      className="mt-3 h-48 w-full rounded-2xl border border-white/10"
      src={`https://www.openstreetmap.org/export/embed.html?bbox=${west},${south},${east},${north}&layer=mapnik&${markerQuery}`}
    />
  );
}
