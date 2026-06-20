import type { CartItem } from "@/types/domain";

export type OfferType = "buy_1_get_1" | "buy_2_get_1";

export type ActiveOffer = {
  type: OfferType;
  active?: boolean;
  eligibleCategories?: string[];
};

export type FreeOfferItem = {
  id: string;
  dishId: string;
  name: string;
  price: number;
  qty: number;
};

export type OfferCalculation = {
  originalTotal: number;
  discount: number;
  finalTotal: number;
  freeItems: FreeOfferItem[];
  offerApplied: boolean;
  offerType?: OfferType;
};

export type OfferCartItem = CartItem & {
  productType?: string;
};
