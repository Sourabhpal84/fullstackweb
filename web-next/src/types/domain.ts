export type TimestampLike = {
  seconds?: number;
  nanoseconds?: number;
  toDate?: () => Date;
};

export type Category = {
  id: string;
  name: string;
  image?: string;
  imageUrl?: string;
  icon?: string;
  photo?: string;
  thumbnail?: string;
  order?: number;
  active?: boolean;
};

export type DishVariant = {
  label?: string;
  name?: string;
  price: number;
  oldPrice?: number;
};

export type Dish = {
  id: string;
  name: string;
  description?: string;
  image?: string;
  category?: string;
  available?: boolean;
  price?: number;
  oldPrice?: number;
  variants?: DishVariant[];
  createdAt?: TimestampLike;
};

export type CartItem = {
  id: string;
  dishId: string;
  name: string;
  image: string;
  price: number;
  qty: number;
  variantLabel?: string;
};

export type OrderStatus =
  | "Pending"
  | "Accepted"
  | "Preparing"
  | "Searching For Rider"
  | "Rider Accepted"
  | "Picked Up"
  | "Out For Delivery"
  | "Reached Nearby"
  | "Collect Payment"
  | "Cash Collected"
  | "Payment Settled"
  | "Delivery Code Pending"
  | "Payment Completed"
  | "Delivered"
  | "Cancelled"
  | "Rejected";

export type GeoPointLike = {
  lat?: number;
  lng?: number;
  accuracy?: number;
  updatedAt?: string;
};

export type DeliverySettings = {
  maxDeliveryDistanceKm?: number;
  maxDistance?: number;
  allIndiaDelivery?: boolean;
  vipDeliveryEnabled?: boolean;
};

export type RestaurantSettings = {
  location?: GeoPointLike;
  unavailable?: boolean;
  unavailableMessage?: string;
};

export type Coupon = {
  id: string;
  code: string;
  active?: boolean;
  deleted?: boolean;
  type?: "percentage" | "flat" | string;
  discountValue?: number;
  maxDiscount?: number;
  minOrderAmount?: number;
  freeDelivery?: boolean;
  usageLimit?: number;
  usedCount?: number;
  visibility?: string;
  vipOnly?: boolean;
  allowedUsers?: string[];
  applicableCategories?: string[];
  firstOrderOnly?: boolean;
  expiryDate?: TimestampLike;
};

export type CustomerOrder = {
  id: string;
  orderNumber?: string;
  items?: Array<{ name: string; qty: number; price: number }>;
  status?: OrderStatus | string;
  totalAmount?: number;
  paymentMethod?: string;
  riderName?: string;
  riderPhone?: string;
  riderStatus?: string;
  riderLocation?: GeoPointLike;
  location?: GeoPointLike;
  createdAt?: TimestampLike;
};

export type ThemeSettings = {
  mode?: "light" | "dark";
  variables?: Record<string, string>;
  hero?: {
    kicker?: string;
    title?: string;
    subtitle?: string;
    primaryButton?: string;
    secondaryButton?: string;
    images?: string[];
    backgroundBlur?: number;
    backgroundBlackIntensity?: number;
    colors?: Record<string, string>;
  };
};
